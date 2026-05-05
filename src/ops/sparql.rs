use std::collections::{BTreeSet, HashMap, HashSet};

use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;
use rusty_v8 as v8;
use spargebra::algebra::{
    AggregateExpression, AggregateFunction, Expression, Function, GraphPattern, OrderExpression,
    PropertyPathExpression,
};
use spargebra::term::{
    GroundTerm, Literal, NamedNode, NamedNodePattern, TermPattern, TriplePattern, Variable,
};
use spargebra::{Query, SparqlParser};

use crate::host::with_host;
use crate::runtime::{install_fn, throw};

const XSD_STRING: &str = "http://www.w3.org/2001/XMLSchema#string";
const XSD_BOOLEAN: &str = "http://www.w3.org/2001/XMLSchema#boolean";
const XSD_INTEGER: &str = "http://www.w3.org/2001/XMLSchema#integer";
const XSD_DECIMAL: &str = "http://www.w3.org/2001/XMLSchema#decimal";
const XSD_DOUBLE: &str = "http://www.w3.org/2001/XMLSchema#double";
const XSD_FLOAT: &str = "http://www.w3.org/2001/XMLSchema#float";

const KNOWN_PREFIXES: &[(&str, &str)] = &[
    ("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "rdf"),
    ("http://www.w3.org/2000/01/rdf-schema#", "rdfs"),
    ("http://www.w3.org/2001/XMLSchema#", "xsd"),
    ("http://xmlns.com/foaf/0.1/", "foaf"),
    ("http://schema.org/", "schema"),
];

pub fn install(scope: &mut v8::PinScope) -> Result<(), String> {
    install_fn(scope, "__op_sparql_query", op_sparql_query)?;
    Ok(())
}

fn op_sparql_query(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 2 {
        throw(scope, "sparql_query requires (query, ref, [graph, limit])");
        return;
    }
    let query = args.get(0).to_rust_string_lossy(scope);
    let ref_name = args.get(1).to_rust_string_lossy(scope);
    let graph_filter = if args.length() > 2 && !args.get(2).is_null_or_undefined() {
        Some(args.get(2).to_rust_string_lossy(scope))
    } else {
        None
    };
    let opt_limit = if args.length() > 3 && args.get(3).is_number() {
        args.get(3)
            .to_integer(scope)
            .map(|n| n.value())
            .filter(|n| *n >= 0)
    } else {
        None
    };

    match run_sparql(&query, &ref_name, graph_filter.as_deref(), opt_limit) {
        Ok(result) => set_sparql_result(scope, &mut rv, result),
        Err(e) => throw(scope, &e),
    }
}

#[derive(Clone, Debug)]
struct SelectRows {
    vars: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
}

enum SparqlResult {
    Select(SelectRows),
    Ask(bool),
    Construct(Vec<[String; 4]>),
}

fn set_sparql_result(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, result: SparqlResult) {
    let obj = v8::Object::new(scope);
    match result {
        SparqlResult::Select(rows) => {
            set_object_str(scope, obj, "type", "select");
            let arr = v8::Array::new(scope, rows.rows.len() as i32);
            for (i, row) in rows.rows.iter().enumerate() {
                let row_obj = v8::Object::new(scope);
                for (key, value) in rows.vars.iter().zip(row) {
                    if let Some(value) = value {
                        set_object_str(scope, row_obj, key, value);
                    }
                }
                arr.set_index(scope, i as u32, row_obj.into());
            }
            set_object_value(scope, obj, "result", arr.into());
        }
        SparqlResult::Ask(value) => {
            set_object_str(scope, obj, "type", "ask");
            set_object_value(scope, obj, "result", v8::Boolean::new(scope, value).into());
        }
        SparqlResult::Construct(quads) => {
            set_object_str(scope, obj, "type", "construct");
            let arr = v8::Array::new(scope, quads.len() as i32);
            for (i, quad) in quads.iter().enumerate() {
                let inner = v8::Array::new(scope, 4);
                for (j, value) in quad.iter().enumerate() {
                    if let Some(s) = v8::String::new(scope, value) {
                        inner.set_index(scope, j as u32, s.into());
                    }
                }
                arr.set_index(scope, i as u32, inner.into());
            }
            set_object_value(scope, obj, "result", arr.into());
        }
    }
    rv.set(obj.into());
}

fn set_object_str(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, key: &str, value: &str) {
    if let (Some(k), Some(v)) = (v8::String::new(scope, key), v8::String::new(scope, value)) {
        obj.set(scope, k.into(), v.into());
    }
}

fn set_object_value(
    scope: &mut v8::PinScope,
    obj: v8::Local<v8::Object>,
    key: &str,
    value: v8::Local<v8::Value>,
) {
    if let Some(k) = v8::String::new(scope, key) {
        obj.set(scope, k.into(), value);
    }
}

fn run_sparql(
    query: &str,
    ref_name: &str,
    graph_filter: Option<&str>,
    opt_limit: Option<i64>,
) -> Result<SparqlResult, String> {
    let parsed = parse_query(query)?;
    let encoder = parsed.encoder;
    match parsed.query {
        Query::Select {
            dataset, pattern, ..
        } => {
            reject_dataset(dataset.as_ref())?;
            let plan = Plan::from_graph_pattern(&pattern, &encoder)?;
            let vars = plan
                .project_vars
                .clone()
                .unwrap_or_else(|| collect_vars(&plan));
            let rows = select_bindings(ref_name, graph_filter, &plan, &vars, opt_limit, &encoder)?;
            Ok(SparqlResult::Select(rows))
        }
        Query::Ask {
            dataset, pattern, ..
        } => {
            reject_dataset(dataset.as_ref())?;
            let plan = Plan::from_graph_pattern(&pattern, &encoder)?;
            let yes = ask(ref_name, graph_filter, &plan, &encoder)?;
            Ok(SparqlResult::Ask(yes))
        }
        Query::Construct {
            template,
            dataset,
            pattern,
            ..
        } => {
            reject_dataset(dataset.as_ref())?;
            let plan = Plan::from_graph_pattern(&pattern, &encoder)?;
            let template = template
                .iter()
                .map(|triple| pattern_from_construct_template(triple, &encoder))
                .collect::<Result<Vec<_>, _>>()?;
            let vars = collect_vars(&plan);
            let rows = select_bindings(ref_name, graph_filter, &plan, &vars, opt_limit, &encoder)?;
            let quads = construct_quads(graph_filter, &template, &rows);
            Ok(SparqlResult::Construct(quads))
        }
        Query::Describe { .. } => Err("unsupported SPARQL query form: DESCRIBE".to_string()),
    }
}

struct ParsedQuery {
    query: Query,
    encoder: TermEncoder,
}

fn parse_query(query: &str) -> Result<ParsedQuery, String> {
    let query = with_auto_prefixes(query);
    let encoder = TermEncoder::new(prefix_declarations(&query));
    let query = SparqlParser::new()
        .parse_query(&query)
        .map_err(|e| format!("SPARQL parse error: {e}"))?;
    Ok(ParsedQuery { query, encoder })
}

#[derive(Clone, Debug)]
struct TermEncoder {
    prefixes: Vec<(String, String)>,
}

impl TermEncoder {
    fn new(mut prefixes: Vec<(String, String)>) -> Self {
        prefixes.extend(
            KNOWN_PREFIXES
                .iter()
                .map(|(base, prefix)| ((*prefix).to_string(), (*base).to_string())),
        );
        prefixes.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));
        prefixes.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1);
        Self { prefixes }
    }

    fn values_for_named_node(&self, node: &NamedNode) -> Vec<String> {
        let iri = node.as_str();
        let mut values = Vec::with_capacity(4);
        if let Some(compact) = self.compact_iri(iri) {
            // Prefer the compact form used by the facts/memory APIs while still
            // matching fully expanded stores.
            values.push(compact);
        }
        values.push(iri.to_string());
        values.push(format!("<{iri}>"));
        dedup(values)
    }

    fn values_for_literal(&self, literal: &Literal) -> Vec<String> {
        let value = literal.value();
        let quoted = quote_string_literal(value);
        if let Some(lang) = literal.language() {
            return vec![format!("{quoted}@{lang}")];
        }

        let datatype = literal.datatype();
        let datatype = datatype.as_str();
        let datatype_compact = self
            .compact_iri(datatype)
            .unwrap_or_else(|| datatype.to_string());

        if datatype == XSD_STRING || datatype_compact == "xsd:string" {
            return vec![quoted];
        }

        let mut values = Vec::new();
        if is_numeric_or_bool_datatype(datatype, &datatype_compact) {
            values.push(value.to_string());
        }

        values.push(format!("{quoted}^^{datatype_compact}"));
        values.push(format!("{quoted}^^<{datatype}>"));
        values.push(format!("{quoted}^^{datatype}"));
        dedup(values)
    }

    fn compact_iri(&self, iri: &str) -> Option<String> {
        for (prefix, base) in &self.prefixes {
            if let Some(local) = iri.strip_prefix(base)
                && !local.is_empty()
            {
                return Some(format!("{prefix}:{local}"));
            }
        }
        None
    }
}

fn reject_dataset(dataset: Option<&spargebra::algebra::QueryDataset>) -> Result<(), String> {
    if dataset.is_some() {
        return Err(
            "SPARQL FROM/FROM NAMED dataset clauses are not supported; use opts.graph or GRAPH instead"
                .to_string(),
        );
    }
    Ok(())
}

#[derive(Clone, Debug)]
enum PatternTerm {
    Var(String),
    Const(ConstTerm),
}

#[derive(Clone, Debug)]
struct ConstTerm {
    values: Vec<String>,
}

impl ConstTerm {
    fn new(values: Vec<String>) -> Self {
        let mut seen = HashSet::new();
        let mut deduped = Vec::with_capacity(values.len());
        for value in values {
            if seen.insert(value.clone()) {
                deduped.push(value);
            }
        }
        Self { values: deduped }
    }

    fn single(value: String) -> Self {
        Self {
            values: vec![value],
        }
    }

    fn primary(&self) -> Option<&str> {
        self.values.first().map(String::as_str)
    }
}

#[derive(Clone, Debug)]
struct Pattern {
    graph: Option<PatternTerm>,
    subject: PatternTerm,
    predicate: PatternTerm,
    object: PatternTerm,
}

#[derive(Clone, Debug)]
struct Extension {
    variable: String,
    expression: Expression,
}

#[derive(Clone, Debug)]
struct OptionalPlan {
    plan: Plan,
    expression: Option<Expression>,
}

#[derive(Clone, Debug)]
struct ValuesBlock {
    variables: Vec<String>,
    bindings: Vec<Vec<Option<String>>>,
}

#[derive(Clone, Debug)]
struct MinusPlan {
    plan: Plan,
}

#[derive(Clone, Debug, Default)]
struct GroupPlan {
    variables: Vec<String>,
    aggregates: Vec<(String, AggregateExpression)>,
    inner: Box<Plan>,
}

#[derive(Clone, Debug)]
enum PlanKind {
    Normal,
    Union(Vec<Plan>),
}

impl Default for PlanKind {
    fn default() -> Self {
        Self::Normal
    }
}

#[derive(Clone, Debug, Default)]
struct Plan {
    kind: PlanKind,
    patterns: Vec<Pattern>,
    optionals: Vec<OptionalPlan>,
    values: Vec<ValuesBlock>,
    minuses: Vec<MinusPlan>,
    extensions: Vec<Extension>,
    filters: Vec<Expression>,
    order: Vec<OrderExpression>,
    group: Option<GroupPlan>,
    project_vars: Option<Vec<String>>,
    distinct: bool,
    limit: Option<i64>,
    offset: Option<i64>,
}

impl Plan {
    fn from_graph_pattern(pattern: &GraphPattern, encoder: &TermEncoder) -> Result<Self, String> {
        let mut plan = Self::default();
        plan.add_graph_pattern(pattern, None, encoder)?;
        Ok(plan)
    }

    fn add_graph_pattern(
        &mut self,
        pattern: &GraphPattern,
        graph: Option<PatternTerm>,
        encoder: &TermEncoder,
    ) -> Result<(), String> {
        match pattern {
            GraphPattern::Bgp { patterns } => {
                self.patterns.reserve(patterns.len());
                for triple in patterns {
                    self.patterns
                        .push(pattern_from_triple(triple, graph.clone(), encoder)?);
                }
                Ok(())
            }
            GraphPattern::Path {
                subject,
                path,
                object,
            } => self.add_property_path(subject, path, object, graph, encoder),
            GraphPattern::Join { left, right } => {
                self.add_graph_pattern(left, graph.clone(), encoder)?;
                self.add_graph_pattern(right, graph, encoder)
            }
            GraphPattern::Graph { name, inner } => {
                let graph = Some(term_from_named_node_pattern(name, encoder));
                self.add_graph_pattern(inner, graph, encoder)
            }
            GraphPattern::Filter { expr, inner } => {
                self.add_graph_pattern(inner, graph, encoder)?;
                self.filters.push(expr.clone());
                Ok(())
            }
            GraphPattern::Project { inner, variables } => {
                self.add_graph_pattern(inner, graph, encoder)?;
                self.project_vars = Some(variables.iter().map(var_key).collect());
                Ok(())
            }
            GraphPattern::Distinct { inner } => {
                self.add_graph_pattern(inner, graph, encoder)?;
                self.distinct = true;
                Ok(())
            }
            GraphPattern::Reduced { inner } => self.add_graph_pattern(inner, graph, encoder),
            GraphPattern::Slice {
                inner,
                start,
                length,
            } => {
                self.add_graph_pattern(inner, graph, encoder)?;
                let start = usize_to_i64(*start)?;
                self.offset = Some(self.offset.unwrap_or(0).saturating_add(start));
                if let Some(length) = length {
                    let length = usize_to_i64(*length)?;
                    self.limit = Some(self.limit.map_or(length, |current| current.min(length)));
                }
                Ok(())
            }
            GraphPattern::OrderBy { inner, expression } => {
                self.add_graph_pattern(inner, graph, encoder)?;
                self.order = expression.clone();
                Ok(())
            }
            GraphPattern::LeftJoin {
                left,
                right,
                expression,
            } => {
                self.add_graph_pattern(left, graph.clone(), encoder)?;
                let mut optional = Plan::default();
                optional.add_graph_pattern(right, graph, encoder)?;
                self.optionals.push(OptionalPlan {
                    plan: optional,
                    expression: expression.clone(),
                });
                Ok(())
            }
            GraphPattern::Union { left, right } => {
                let mut left_plan = Plan::default();
                left_plan.add_graph_pattern(left, graph.clone(), encoder)?;
                let mut right_plan = Plan::default();
                right_plan.add_graph_pattern(right, graph, encoder)?;
                self.kind = PlanKind::Union(vec![left_plan, right_plan]);
                Ok(())
            }
            GraphPattern::Extend {
                inner,
                variable,
                expression,
            } => {
                self.add_graph_pattern(inner, graph, encoder)?;
                self.extensions.push(Extension {
                    variable: var_key(variable),
                    expression: expression.clone(),
                });
                Ok(())
            }
            GraphPattern::Minus { left, right } => {
                self.add_graph_pattern(left, graph.clone(), encoder)?;
                let mut minus = Plan::default();
                minus.add_graph_pattern(right, graph, encoder)?;
                self.minuses.push(MinusPlan { plan: minus });
                Ok(())
            }
            GraphPattern::Values {
                variables,
                bindings,
            } => {
                self.values.push(ValuesBlock {
                    variables: variables.iter().map(var_key).collect(),
                    bindings: bindings
                        .iter()
                        .map(|row| {
                            row.iter()
                                .map(|term| {
                                    term.as_ref()
                                        .map(|term| ground_term_to_string(term, encoder))
                                })
                                .collect()
                        })
                        .collect(),
                });
                Ok(())
            }
            GraphPattern::Group {
                inner,
                variables,
                aggregates,
            } => {
                let mut inner_plan = Plan::default();
                inner_plan.add_graph_pattern(inner, graph, encoder)?;
                self.group = Some(GroupPlan {
                    variables: variables.iter().map(var_key).collect(),
                    aggregates: aggregates
                        .iter()
                        .map(|(var, agg)| (var_key(var), agg.clone()))
                        .collect(),
                    inner: Box::new(inner_plan),
                });
                Ok(())
            }
            GraphPattern::Service { .. } => Err(
                "unsupported SPARQL algebra: SERVICE is not available in local facts".to_string(),
            ),
        }
    }

    fn add_property_path(
        &mut self,
        subject: &TermPattern,
        path: &PropertyPathExpression,
        object: &TermPattern,
        graph: Option<PatternTerm>,
        encoder: &TermEncoder,
    ) -> Result<(), String> {
        match path {
            PropertyPathExpression::NamedNode(predicate) => {
                self.patterns.push(Pattern {
                    graph,
                    subject: term_from_term_pattern(subject, encoder),
                    predicate: PatternTerm::Const(ConstTerm::new(encoder.values_for_named_node(predicate))),
                    object: term_from_term_pattern(object, encoder),
                });
                Ok(())
            }
            PropertyPathExpression::Reverse(inner) => {
                if let PropertyPathExpression::NamedNode(predicate) = inner.as_ref() {
                    self.patterns.push(Pattern {
                        graph,
                        subject: term_from_term_pattern(object, encoder),
                        predicate: PatternTerm::Const(ConstTerm::new(encoder.values_for_named_node(predicate))),
                        object: term_from_term_pattern(subject, encoder),
                    });
                    Ok(())
                } else {
                    Err("unsupported SPARQL property path: only direct named predicates and ^predicate are supported".to_string())
                }
            }
            PropertyPathExpression::Sequence(left, right) => {
                let mid = hidden_var("path");
                let mid_term = TermPattern::Variable(Variable::new_unchecked(mid.trim_start_matches('?')));
                self.add_property_path(subject, left, &mid_term, graph.clone(), encoder)?;
                self.add_property_path(&mid_term, right, object, graph, encoder)
            }
            _ => Err(
                "unsupported SPARQL property path: only direct, reverse, and sequence paths are supported"
                    .to_string(),
            ),
        }
    }
}

fn usize_to_i64(n: usize) -> Result<i64, String> {
    i64::try_from(n).map_err(|_| format!("SPARQL integer is too large: {n}"))
}

fn hidden_var(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!("?__moo_{prefix}_{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

fn pattern_from_triple(
    triple: &TriplePattern,
    graph: Option<PatternTerm>,
    encoder: &TermEncoder,
) -> Result<Pattern, String> {
    Ok(Pattern {
        graph,
        subject: term_from_term_pattern(&triple.subject, encoder),
        predicate: term_from_named_node_pattern(&triple.predicate, encoder),
        object: term_from_term_pattern(&triple.object, encoder),
    })
}

fn pattern_from_construct_template(
    triple: &TriplePattern,
    encoder: &TermEncoder,
) -> Result<Pattern, String> {
    Ok(Pattern {
        graph: None,
        subject: term_from_template_term(&triple.subject, encoder),
        predicate: term_from_named_node_pattern(&triple.predicate, encoder),
        object: term_from_template_term(&triple.object, encoder),
    })
}

fn ground_term_to_string(term: &GroundTerm, encoder: &TermEncoder) -> String {
    match term {
        GroundTerm::NamedNode(node) => encoder
            .values_for_named_node(node)
            .into_iter()
            .next()
            .unwrap_or_else(|| node.as_str().to_string()),
        GroundTerm::Literal(literal) => encoder
            .values_for_literal(literal)
            .into_iter()
            .next()
            .unwrap_or_else(|| literal.to_string()),
    }
}

fn term_from_named_node_pattern(pattern: &NamedNodePattern, encoder: &TermEncoder) -> PatternTerm {
    match pattern {
        NamedNodePattern::NamedNode(node) => {
            PatternTerm::Const(ConstTerm::new(encoder.values_for_named_node(node)))
        }
        NamedNodePattern::Variable(var) => PatternTerm::Var(var_key(var)),
    }
}

fn term_from_term_pattern(pattern: &TermPattern, encoder: &TermEncoder) -> PatternTerm {
    match pattern {
        TermPattern::NamedNode(node) => {
            PatternTerm::Const(ConstTerm::new(encoder.values_for_named_node(node)))
        }
        TermPattern::BlankNode(node) => PatternTerm::Var(format!("_:{}", node.as_str())),
        TermPattern::Literal(literal) => {
            PatternTerm::Const(ConstTerm::new(encoder.values_for_literal(literal)))
        }
        TermPattern::Variable(var) => PatternTerm::Var(var_key(var)),
    }
}

fn term_from_template_term(pattern: &TermPattern, encoder: &TermEncoder) -> PatternTerm {
    match pattern {
        TermPattern::BlankNode(node) => {
            PatternTerm::Const(ConstTerm::single(format!("_:{}", node.as_str())))
        }
        _ => term_from_term_pattern(pattern, encoder),
    }
}

fn var_key(var: &Variable) -> String {
    format!("?{}", var.as_str())
}

fn is_numeric_or_bool_datatype(datatype: &str, compact: &str) -> bool {
    matches!(
        datatype,
        XSD_BOOLEAN | XSD_INTEGER | XSD_DECIMAL | XSD_DOUBLE | XSD_FLOAT
    ) || matches!(
        compact,
        "xsd:boolean" | "xsd:integer" | "xsd:decimal" | "xsd:double" | "xsd:float"
    )
}

fn quote_string_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn collect_vars(plan: &Plan) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    if let Some(group) = &plan.group {
        for var in &group.variables {
            push_visible_var(var, &mut seen, &mut out);
        }
        for (var, _) in &group.aggregates {
            push_visible_var(var, &mut seen, &mut out);
        }
    }
    for p in &plan.patterns {
        for term in [
            p.graph.as_ref(),
            Some(&p.subject),
            Some(&p.predicate),
            Some(&p.object),
        ]
        .into_iter()
        .flatten()
        {
            if let PatternTerm::Var(v) = term {
                push_visible_var(v, &mut seen, &mut out);
            }
        }
    }
    if let PlanKind::Union(branches) = &plan.kind {
        for branch in branches {
            for var in collect_vars(branch) {
                push_visible_var(&var, &mut seen, &mut out);
            }
        }
    }
    for optional in &plan.optionals {
        for var in collect_vars(&optional.plan) {
            push_visible_var(&var, &mut seen, &mut out);
        }
    }
    for values in &plan.values {
        for var in &values.variables {
            push_visible_var(var, &mut seen, &mut out);
        }
    }
    for extension in &plan.extensions {
        push_visible_var(&extension.variable, &mut seen, &mut out);
    }
    out
}

fn push_visible_var(var: &str, seen: &mut HashSet<String>, out: &mut Vec<String>) {
    if !var.starts_with('?') || var.starts_with("?__moo_") {
        return;
    }
    if seen.insert(var.to_string()) {
        out.push(var.to_string());
    }
}

fn select_bindings(
    ref_name: &str,
    graph_filter: Option<&str>,
    plan: &Plan,
    vars: &[String],
    opt_limit: Option<i64>,
    encoder: &TermEncoder,
) -> Result<SelectRows, String> {
    let limit = match (opt_limit, plan.limit) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    if limit == Some(0) {
        return Ok(SelectRows {
            vars: vars.to_vec(),
            rows: Vec::new(),
        });
    }

    if let PlanKind::Union(branches) = &plan.kind {
        return select_union_bindings(
            ref_name,
            graph_filter,
            plan,
            branches,
            vars,
            opt_limit,
            encoder,
        );
    }

    let mut sql_args = SqlBuilder::new();
    let fragments = compile_plan_sql(ref_name, graph_filter, plan, &mut sql_args, encoder)?;

    let select_cols = vars
        .iter()
        .map(|v| {
            fragments
                .var_cols
                .get(v)
                .cloned()
                .ok_or_else(|| format!("SELECT variable is not bound in WHERE: {v}"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut sql = String::from("select ");
    if plan.distinct {
        sql.push_str("distinct ");
    }
    if select_cols.is_empty() {
        sql.push('1');
    } else {
        sql.push_str(&select_cols.join(", "));
    }
    if fragments.from.is_empty() {
        sql.push_str(" from (select 1) base");
    } else {
        sql.push_str(" from ");
        sql.push_str(&fragments.from.join(", "));
    }
    for join in fragments.joins {
        sql.push(' ');
        sql.push_str(&join);
    }
    if !fragments.clauses.is_empty() {
        sql.push_str(" where ");
        sql.push_str(&fragments.clauses.join(" and "));
    }

    let order_cols = compile_order(&plan.order, &fragments.var_cols, &mut sql_args, encoder)?;
    if !order_cols.is_empty() {
        sql.push_str(" order by ");
        sql.push_str(&order_cols.join(", "));
    }
    if let Some(n) = limit {
        sql.push_str(" limit ");
        sql.push_str(&sql_args.push_i64(n));
    }
    if let Some(n) = plan.offset.filter(|n| *n > 0) {
        if limit.is_none() {
            sql.push_str(" limit -1");
        }
        sql.push_str(" offset ");
        sql.push_str(&sql_args.push_i64(n));
    }

    with_host(|h| {
        let mut stmt = h.db.prepare_cached(&sql).map_err(|e| e.to_string())?;
        let iter = stmt
            .query_map(params_from_iter(sql_args.vals.iter()), |r| {
                let mut row = Vec::with_capacity(vars.len());
                for i in 0..vars.len() {
                    row.push(r.get::<_, Option<String>>(i)?);
                }
                Ok(row)
            })
            .map_err(|e| e.to_string())?;
        let rows = iter
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(SelectRows {
            vars: vars.to_vec(),
            rows,
        })
    })
}

fn select_union_bindings(
    ref_name: &str,
    graph_filter: Option<&str>,
    plan: &Plan,
    branches: &[Plan],
    vars: &[String],
    opt_limit: Option<i64>,
    encoder: &TermEncoder,
) -> Result<SelectRows, String> {
    let mut rows = Vec::<Vec<Option<String>>>::new();
    let mut seen = HashSet::new();
    let mut branch_limit = None;
    let final_limit = match (opt_limit, plan.limit) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    if let Some(limit) = final_limit {
        branch_limit = plan.offset.map(|offset| limit.saturating_add(offset));
    }

    for branch in branches {
        let branch_vars = collect_vars(branch);
        let branch_rows = select_bindings(
            ref_name,
            graph_filter,
            branch,
            &branch_vars,
            branch_limit,
            encoder,
        )?;
        for row in branch_rows.rows {
            let mapped = vars
                .iter()
                .map(|var| {
                    branch_rows
                        .vars
                        .iter()
                        .position(|candidate| candidate == var)
                        .and_then(|idx| row.get(idx).cloned())
                        .flatten()
                })
                .collect::<Vec<_>>();
            if !plan.distinct || seen.insert(mapped.clone()) {
                rows.push(mapped);
            }
        }
    }

    for order in &plan.order {
        if !matches!(
            order,
            OrderExpression::Asc(Expression::Variable(_))
                | OrderExpression::Desc(Expression::Variable(_))
        ) {
            return Err(
                "unsupported SPARQL UNION ORDER BY: only variables are supported".to_string(),
            );
        }
    }
    for order in plan.order.iter().rev() {
        match order {
            OrderExpression::Asc(Expression::Variable(var)) => {
                let key = var_key(var);
                if let Some(idx) = vars.iter().position(|candidate| candidate == &key) {
                    rows.sort_by(|a, b| a[idx].cmp(&b[idx]));
                }
            }
            OrderExpression::Desc(Expression::Variable(var)) => {
                let key = var_key(var);
                if let Some(idx) = vars.iter().position(|candidate| candidate == &key) {
                    rows.sort_by(|a, b| b[idx].cmp(&a[idx]));
                }
            }
            _ => {}
        }
    }

    if let Some(offset) = plan.offset.filter(|offset| *offset > 0) {
        let offset = usize::try_from(offset).unwrap_or(usize::MAX);
        rows = rows.into_iter().skip(offset).collect();
    }
    if let Some(limit) = final_limit {
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        rows.truncate(limit);
    }
    Ok(SelectRows {
        vars: vars.to_vec(),
        rows,
    })
}

#[derive(Default)]
struct SqlFragments {
    from: Vec<String>,
    joins: Vec<String>,
    clauses: Vec<String>,
    var_cols: HashMap<String, String>,
}

fn compile_plan_sql(
    ref_name: &str,
    graph_filter: Option<&str>,
    plan: &Plan,
    sql_args: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<SqlFragments, String> {
    compile_plan_sql_with_prefix(ref_name, graph_filter, plan, sql_args, encoder, "")
}

fn compile_plan_sql_with_prefix(
    ref_name: &str,
    graph_filter: Option<&str>,
    plan: &Plan,
    sql_args: &mut SqlBuilder,
    encoder: &TermEncoder,
    alias_prefix: &str,
) -> Result<SqlFragments, String> {
    let mut fragments = SqlFragments::default();
    let ordered = optimized_pattern_order(&plan.patterns, graph_filter.is_some());

    for (alias_idx, pattern_idx) in ordered.iter().enumerate() {
        let p = &plan.patterns[*pattern_idx];
        let q = format!("{alias_prefix}q{alias_idx}");
        fragments.from.push(format!("quads {q}"));
        sql_args.add_const(&mut fragments.clauses, &format!("{q}.ref_name"), ref_name);
        match &p.graph {
            Some(term) => {
                let graph_col = format!("{q}.graph");
                add_term(
                    term,
                    &graph_col,
                    &mut fragments.var_cols,
                    &mut fragments.clauses,
                    sql_args,
                );
                if let Some(g) = graph_filter {
                    match term {
                        PatternTerm::Const(c) if c.values.iter().any(|v| v == g) => {}
                        PatternTerm::Const(_) => fragments.clauses.push("0".to_string()),
                        PatternTerm::Var(_) => {
                            sql_args.add_const(&mut fragments.clauses, &graph_col, g)
                        }
                    }
                }
            }
            None => {
                if let Some(g) = graph_filter {
                    sql_args.add_const(&mut fragments.clauses, &format!("{q}.graph"), g);
                }
            }
        }
        add_term(
            &p.subject,
            &format!("{q}.subject"),
            &mut fragments.var_cols,
            &mut fragments.clauses,
            sql_args,
        );
        add_term(
            &p.predicate,
            &format!("{q}.predicate"),
            &mut fragments.var_cols,
            &mut fragments.clauses,
            sql_args,
        );
        add_term(
            &p.object,
            &format!("{q}.object"),
            &mut fragments.var_cols,
            &mut fragments.clauses,
            sql_args,
        );
    }

    for (idx, values) in plan.values.iter().enumerate() {
        add_values_block(alias_prefix, idx, values, &mut fragments, sql_args)?;
    }

    if let Some(group) = &plan.group {
        let grouped = compile_group_plan(
            ref_name,
            graph_filter,
            group,
            &fragments.var_cols,
            sql_args,
            encoder,
            alias_prefix,
        )?;
        fragments.from.push(grouped.from_sql);
        for (var, col) in grouped.outer_var_cols {
            if let Some(existing) = fragments.var_cols.get(&var) {
                fragments.clauses.push(format!("{existing} = {col}"));
            } else {
                fragments.var_cols.insert(var, col);
            }
        }
    }

    for extension in &plan.extensions {
        if fragments.var_cols.contains_key(&extension.variable) {
            if let Expression::Variable(source) = &extension.expression {
                let source = var_key(source);
                if source != extension.variable {
                    if let Some(col) = fragments.var_cols.get(&source).cloned() {
                        fragments.var_cols.insert(extension.variable.clone(), col);
                        continue;
                    }
                }
            }
            return Err(format!(
                "SPARQL BIND target is already bound in WHERE: {}",
                extension.variable
            ));
        }
        let compiled = if let Some(group) = &plan.group {
            compile_grouped_value_expression(
                &extension.expression,
                &fragments.var_cols,
                &group.variables,
                sql_args,
                encoder,
            )?
        } else {
            compile_value_expression(
                &extension.expression,
                &fragments.var_cols,
                sql_args,
                encoder,
            )?
        };
        fragments
            .var_cols
            .insert(extension.variable.clone(), compiled);
    }

    for filter in &plan.filters {
        let clause = if let Some(group) = &plan.group {
            compile_grouped_boolean_expression(
                filter,
                &fragments.var_cols,
                &group.variables,
                sql_args,
                encoder,
            )?
        } else {
            compile_filter(filter, &fragments.var_cols, sql_args, encoder)?
        };
        fragments.clauses.push(clause);
    }

    for (idx, optional) in plan.optionals.iter().enumerate() {
        add_optional_join(
            ref_name,
            graph_filter,
            alias_prefix,
            idx,
            optional,
            &mut fragments,
            sql_args,
            encoder,
        )?;
    }

    for minus in &plan.minuses {
        add_minus_filter(
            ref_name,
            graph_filter,
            alias_prefix,
            minus,
            &mut fragments,
            sql_args,
            encoder,
        )?;
    }

    Ok(fragments)
}

#[derive(Debug)]
struct CompiledGroup {
    from_sql: String,
    outer_var_cols: HashMap<String, String>,
}

fn compile_group_plan(
    ref_name: &str,
    graph_filter: Option<&str>,
    group: &GroupPlan,
    outer_var_cols: &HashMap<String, String>,
    sql_args: &mut SqlBuilder,
    encoder: &TermEncoder,
    alias_prefix: &str,
) -> Result<CompiledGroup, String> {
    let group_alias = format!("{alias_prefix}grp");
    let inner_prefix = format!("{alias_prefix}g_");
    let inner = compile_plan_sql_with_prefix(
        ref_name,
        graph_filter,
        &group.inner,
        sql_args,
        encoder,
        &inner_prefix,
    )?;

    let mut group_cols = Vec::with_capacity(group.variables.len());
    let mut select_cols = Vec::with_capacity(group.variables.len() + group.aggregates.len());
    let mut outer_cols = HashMap::new();

    for (idx, var) in group.variables.iter().enumerate() {
        let expr = inner
            .var_cols
            .get(var)
            .cloned()
            .ok_or_else(|| format!("GROUP BY variable is not bound in WHERE: {var}"))?;
        let alias = quote_sql_identifier(&format!("v{idx}"));
        group_cols.push(expr.clone());
        select_cols.push(format!("{expr} as {alias}"));
        outer_cols.insert(var.clone(), format!("{group_alias}.{alias}"));
    }

    for (idx, (var, aggregate)) in group.aggregates.iter().enumerate() {
        let expr = compile_aggregate_expression(aggregate, &inner.var_cols, sql_args, encoder)?;
        let alias = quote_sql_identifier(&format!("a{idx}"));
        select_cols.push(format!("{expr} as {alias}"));
        outer_cols.insert(var.clone(), format!("{group_alias}.{alias}"));
    }

    if select_cols.is_empty() {
        select_cols.push("1 as __empty_group".to_string());
    }

    let mut sql = String::from("(select ");
    sql.push_str(&select_cols.join(", "));
    if inner.from.is_empty() {
        sql.push_str(" from (select 1) base");
    } else {
        sql.push_str(" from ");
        sql.push_str(&inner.from.join(", "));
    }
    for join in inner.joins {
        sql.push(' ');
        sql.push_str(&join);
    }

    let mut clauses = inner.clauses;
    for var in &group.variables {
        if let (Some(inner_col), Some(outer_col)) =
            (inner.var_cols.get(var), outer_var_cols.get(var))
        {
            clauses.push(format!("{inner_col} = {outer_col}"));
        }
    }
    if !clauses.is_empty() {
        sql.push_str(" where ");
        sql.push_str(&clauses.join(" and "));
    }
    if !group_cols.is_empty() {
        sql.push_str(" group by ");
        sql.push_str(&group_cols.join(", "));
    }
    sql.push_str(") ");
    sql.push_str(&group_alias);

    Ok(CompiledGroup {
        from_sql: sql,
        outer_var_cols: outer_cols,
    })
}

fn compile_aggregate_expression(
    aggregate: &AggregateExpression,
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    match aggregate {
        AggregateExpression::CountSolutions { distinct } => {
            if *distinct {
                let mut vars = var_cols.iter().collect::<Vec<_>>();
                vars.sort_by(|a, b| a.0.cmp(b.0));
                if vars.is_empty() {
                    Ok("cast(count(distinct 1) as text)".to_string())
                } else {
                    let parts = vars
                        .into_iter()
                        .map(|(_, col)| format!("coalesce({col}, char(0))"))
                        .collect::<Vec<_>>();
                    Ok(format!(
                        "cast(count(distinct {}) as text)",
                        parts.join(" || char(31) || ")
                    ))
                }
            } else {
                Ok("cast(count(*) as text)".to_string())
            }
        }
        AggregateExpression::FunctionCall {
            name,
            expr,
            distinct,
        } => compile_aggregate_function(name, expr, *distinct, var_cols, sql, encoder),
    }
}

fn compile_aggregate_function(
    name: &AggregateFunction,
    expr: &Expression,
    distinct: bool,
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    let distinct_sql = if distinct { "distinct " } else { "" };
    match name {
        AggregateFunction::Count => {
            let value = compile_value_expression(expr, var_cols, sql, encoder)?;
            Ok(format!("cast(count({distinct_sql}{value}) as text)"))
        }
        AggregateFunction::Sum => {
            let value = compile_numeric_expression(expr, var_cols, sql, encoder)?;
            Ok(format!("cast(sum({distinct_sql}{value}) as text)"))
        }
        AggregateFunction::Avg => {
            let value = compile_numeric_expression(expr, var_cols, sql, encoder)?;
            Ok(format!("cast(avg({distinct_sql}{value}) as text)"))
        }
        AggregateFunction::Min => {
            let value = compile_value_expression(expr, var_cols, sql, encoder)?;
            Ok(format!("min({distinct_sql}{value})"))
        }
        AggregateFunction::Max => {
            let value = compile_value_expression(expr, var_cols, sql, encoder)?;
            Ok(format!("max({distinct_sql}{value})"))
        }
        AggregateFunction::Sample => {
            let value = compile_value_expression(expr, var_cols, sql, encoder)?;
            Ok(format!("min({distinct_sql}{value})"))
        }
        AggregateFunction::GroupConcat { separator } => {
            let value = compile_string_expression(expr, var_cols, sql, encoder)?;
            let separator = separator.as_deref().unwrap_or(" ");
            let lexical = if distinct {
                if separator == "," {
                    format!("group_concat(distinct {value})")
                } else {
                    return Err("unsupported SPARQL GROUP_CONCAT(DISTINCT ...) with a custom separator in SQLite".to_string());
                }
            } else {
                let sep = sql.push_text(separator);
                format!("group_concat({value}, {sep})")
            };
            Ok(quote_sql_string_literal(&lexical))
        }
        AggregateFunction::Custom(iri) => Err(format!(
            "unsupported SPARQL custom aggregate for SQLite compilation: {iri}"
        )),
    }
}

fn compile_grouped_value_expression(
    expr: &Expression,
    var_cols: &HashMap<String, String>,
    group_vars: &[String],
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    if let Expression::Variable(var) = expr {
        let key = var_key(var);
        if !group_vars.iter().any(|v| v == &key) && !var_cols.contains_key(&key) {
            return Err(format!(
                "SPARQL grouped expression variable is neither grouped nor aggregated: {key}"
            ));
        }
    }
    compile_value_expression(expr, var_cols, sql, encoder)
}

fn compile_grouped_boolean_expression(
    expr: &Expression,
    var_cols: &HashMap<String, String>,
    group_vars: &[String],
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    validate_grouped_expression(expr, var_cols, group_vars)?;
    compile_boolean_expression(expr, var_cols, sql, encoder)
}

fn validate_grouped_expression(
    expr: &Expression,
    var_cols: &HashMap<String, String>,
    group_vars: &[String],
) -> Result<(), String> {
    match expr {
        Expression::Variable(var) => {
            let key = var_key(var);
            if group_vars.iter().any(|v| v == &key) || var_cols.contains_key(&key) {
                Ok(())
            } else {
                Err(format!(
                    "SPARQL grouped expression variable is neither grouped nor aggregated: {key}"
                ))
            }
        }
        Expression::Or(a, b)
        | Expression::And(a, b)
        | Expression::Equal(a, b)
        | Expression::SameTerm(a, b)
        | Expression::Greater(a, b)
        | Expression::GreaterOrEqual(a, b)
        | Expression::Less(a, b)
        | Expression::LessOrEqual(a, b)
        | Expression::Add(a, b)
        | Expression::Subtract(a, b)
        | Expression::Multiply(a, b)
        | Expression::Divide(a, b) => {
            validate_grouped_expression(a, var_cols, group_vars)?;
            validate_grouped_expression(b, var_cols, group_vars)
        }
        Expression::Not(inner) | Expression::UnaryPlus(inner) | Expression::UnaryMinus(inner) => {
            validate_grouped_expression(inner, var_cols, group_vars)
        }
        Expression::Bound(var) => {
            let key = var_key(var);
            if group_vars.iter().any(|v| v == &key) || var_cols.contains_key(&key) {
                Ok(())
            } else {
                Err(format!(
                    "SPARQL grouped expression variable is neither grouped nor aggregated: {key}"
                ))
            }
        }
        Expression::In(needle, haystack) => {
            validate_grouped_expression(needle, var_cols, group_vars)?;
            for expr in haystack {
                validate_grouped_expression(expr, var_cols, group_vars)?;
            }
            Ok(())
        }
        Expression::FunctionCall(_, args) | Expression::Coalesce(args) => {
            for arg in args {
                validate_grouped_expression(arg, var_cols, group_vars)?;
            }
            Ok(())
        }
        Expression::If(condition, then_expr, else_expr) => {
            validate_grouped_expression(condition, var_cols, group_vars)?;
            validate_grouped_expression(then_expr, var_cols, group_vars)?;
            validate_grouped_expression(else_expr, var_cols, group_vars)
        }
        Expression::NamedNode(_) | Expression::Literal(_) => Ok(()),
        _ => Ok(()),
    }
}

fn add_values_block(
    alias_prefix: &str,
    idx: usize,
    values: &ValuesBlock,
    fragments: &mut SqlFragments,
    sql_args: &mut SqlBuilder,
) -> Result<(), String> {
    if values.variables.is_empty() {
        if values.bindings.is_empty() {
            fragments.clauses.push("0".to_string());
        }
        return Ok(());
    }
    if values.bindings.is_empty() {
        fragments.clauses.push("0".to_string());
        return Ok(());
    }

    let alias = format!("{alias_prefix}val{idx}");
    let mut selects = Vec::with_capacity(values.bindings.len());
    for row in &values.bindings {
        if row.len() != values.variables.len() {
            return Err(
                "malformed SPARQL VALUES block: row width does not match variables".to_string(),
            );
        }
        let cols = row
            .iter()
            .enumerate()
            .map(|(col_idx, value)| {
                let expr = match value {
                    Some(value) => sql_args.push_text(value),
                    None => "null".to_string(),
                };
                format!(
                    "{} as {}",
                    expr,
                    quote_sql_identifier(&format!("v{col_idx}"))
                )
            })
            .collect::<Vec<_>>();
        selects.push(format!("select {}", cols.join(", ")));
    }
    fragments
        .from
        .push(format!("({}) {alias}", selects.join(" union all ")));

    for (col_idx, var) in values.variables.iter().enumerate() {
        let col = format!("{}.{}", alias, quote_sql_identifier(&format!("v{col_idx}")));
        if let Some(existing) = fragments.var_cols.get(var) {
            fragments
                .clauses
                .push(format!("({col} is null or {existing} = {col})"));
        } else {
            fragments.var_cols.insert(var.clone(), col);
        }
    }
    Ok(())
}

fn add_minus_filter(
    ref_name: &str,
    graph_filter: Option<&str>,
    alias_prefix: &str,
    minus: &MinusPlan,
    outer: &mut SqlFragments,
    sql_args: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<(), String> {
    let nested_prefix = format!("{alias_prefix}m_");
    let inner = compile_plan_sql_with_prefix(
        ref_name,
        graph_filter,
        &minus.plan,
        sql_args,
        encoder,
        &nested_prefix,
    )?;
    let mut shared = Vec::new();
    for (var, outer_col) in &outer.var_cols {
        if let Some(inner_col) = inner.var_cols.get(var) {
            shared.push(format!("{outer_col} = {inner_col}"));
        }
    }
    if shared.is_empty() {
        return Ok(());
    }

    let mut subquery = String::from("select 1");
    if inner.from.is_empty() {
        subquery.push_str(" from (select 1) base");
    } else {
        subquery.push_str(" from ");
        subquery.push_str(&inner.from.join(", "));
    }
    for join in inner.joins {
        subquery.push(' ');
        subquery.push_str(&join);
    }
    let mut clauses = inner.clauses;
    clauses.extend(shared);
    if !clauses.is_empty() {
        subquery.push_str(" where ");
        subquery.push_str(&clauses.join(" and "));
    }
    outer.clauses.push(format!("not exists ({subquery})"));
    Ok(())
}

fn add_optional_join(
    ref_name: &str,
    graph_filter: Option<&str>,
    alias_prefix: &str,
    idx: usize,
    optional: &OptionalPlan,
    outer: &mut SqlFragments,
    sql_args: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<(), String> {
    let nested_prefix = format!("{alias_prefix}o{idx}_");
    let inner = compile_plan_sql_with_prefix(
        ref_name,
        graph_filter,
        &optional.plan,
        sql_args,
        encoder,
        &nested_prefix,
    )?;
    let inner_vars = collect_vars(&optional.plan);
    if inner_vars.is_empty() {
        return Ok(());
    }

    let mut select_cols = Vec::with_capacity(inner_vars.len());
    let mut projected = HashMap::<String, String>::new();
    for (col_idx, var) in inner_vars.iter().enumerate() {
        if let Some(col) = inner.var_cols.get(var) {
            let alias = format!("v{col_idx}");
            select_cols.push(format!("{} as {}", col, quote_sql_identifier(&alias)));
            projected.insert(var.clone(), alias);
        }
    }
    if select_cols.is_empty() {
        return Ok(());
    }

    let mut subquery = String::from("select distinct ");
    subquery.push_str(&select_cols.join(", "));
    if inner.from.is_empty() {
        subquery.push_str(" from (select 1) base");
    } else {
        subquery.push_str(" from ");
        subquery.push_str(&inner.from.join(", "));
    }
    for join in inner.joins {
        subquery.push(' ');
        subquery.push_str(&join);
    }
    if !inner.clauses.is_empty() {
        subquery.push_str(" where ");
        subquery.push_str(&inner.clauses.join(" and "));
    }

    let alias = format!("{alias_prefix}opt{idx}");
    let mut on = Vec::new();
    for (var, col_alias) in &projected {
        if let Some(outer_col) = outer.var_cols.get(var) {
            on.push(format!(
                "{} = {}.{}",
                outer_col,
                alias,
                quote_sql_identifier(col_alias)
            ));
        }
    }
    if let Some(expr) = &optional.expression {
        let mut joined_cols = outer.var_cols.clone();
        for (var, col_alias) in &projected {
            joined_cols.insert(
                var.clone(),
                format!("{}.{}", alias, quote_sql_identifier(col_alias)),
            );
        }
        on.push(compile_filter(expr, &joined_cols, sql_args, encoder)?);
    }
    if on.is_empty() {
        on.push("1".to_string());
    }

    outer.joins.push(format!(
        "left join ({subquery}) {alias} on {}",
        on.join(" and ")
    ));
    for (var, col_alias) in projected {
        outer
            .var_cols
            .entry(var)
            .or_insert_with(|| format!("{}.{}", alias, quote_sql_identifier(&col_alias)));
    }
    Ok(())
}

fn quote_sql_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn ask(
    ref_name: &str,
    graph_filter: Option<&str>,
    plan: &Plan,
    encoder: &TermEncoder,
) -> Result<bool, String> {
    Ok(
        !select_bindings(ref_name, graph_filter, plan, &[], Some(1), encoder)?
            .rows
            .is_empty(),
    )
}

struct SqlBuilder {
    vals: Vec<SqlValue>,
}

impl SqlBuilder {
    fn new() -> Self {
        Self { vals: Vec::new() }
    }

    fn placeholder(&self) -> String {
        format!("?{}", self.vals.len() + 1)
    }

    fn push_text(&mut self, value: &str) -> String {
        let placeholder = self.placeholder();
        self.vals.push(SqlValue::Text(value.to_string()));
        placeholder
    }

    fn push_i64(&mut self, value: i64) -> String {
        let placeholder = self.placeholder();
        self.vals.push(SqlValue::Integer(value));
        placeholder
    }

    fn add_const(&mut self, clauses: &mut Vec<String>, col: &str, value: &str) {
        let placeholder = self.push_text(value);
        clauses.push(format!("{col} = {placeholder}"));
    }

    fn const_values_clause(&mut self, col: &str, values: &[String]) -> String {
        match values {
            [] => "0".to_string(),
            [value] => {
                let placeholder = self.push_text(value);
                format!("{col} = {placeholder}")
            }
            _ => {
                let mut clause = String::with_capacity(col.len() + values.len() * 5 + 8);
                clause.push_str(col);
                clause.push_str(" in (");
                for (i, value) in values.iter().enumerate() {
                    if i > 0 {
                        clause.push_str(", ");
                    }
                    let placeholder = self.push_text(value);
                    clause.push_str(&placeholder);
                }
                clause.push(')');
                clause
            }
        }
    }

    fn add_const_values(&mut self, clauses: &mut Vec<String>, col: &str, values: &[String]) {
        clauses.push(self.const_values_clause(col, values));
    }
}

fn add_term(
    term: &PatternTerm,
    col: &str,
    var_cols: &mut HashMap<String, String>,
    clauses: &mut Vec<String>,
    sql: &mut SqlBuilder,
) {
    match term {
        PatternTerm::Const(c) => sql.add_const_values(clauses, col, &c.values),
        PatternTerm::Var(v) => {
            if let Some(prev) = var_cols.get(v) {
                clauses.push(format!("{col} = {prev}"));
            } else {
                var_cols.insert(v.clone(), col.to_string());
            }
        }
    }
}

fn compile_filter(
    expr: &Expression,
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    compile_boolean_expression(expr, var_cols, sql, encoder)
}

fn compile_boolean_expression(
    expr: &Expression,
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    match expr {
        Expression::And(left, right) => Ok(format!(
            "({}) and ({})",
            compile_boolean_expression(left, var_cols, sql, encoder)?,
            compile_boolean_expression(right, var_cols, sql, encoder)?
        )),
        Expression::Or(left, right) => Ok(format!(
            "({}) or ({})",
            compile_boolean_expression(left, var_cols, sql, encoder)?,
            compile_boolean_expression(right, var_cols, sql, encoder)?
        )),
        Expression::Not(inner) => Ok(format!(
            "not ({})",
            compile_boolean_expression(inner, var_cols, sql, encoder)?
        )),
        Expression::Equal(left, right) | Expression::SameTerm(left, right) => {
            compile_equality_filter(left, right, var_cols, sql, encoder)
        }
        Expression::Greater(left, right) => {
            compile_comparison_filter(left, right, ">", var_cols, sql, encoder)
        }
        Expression::GreaterOrEqual(left, right) => {
            compile_comparison_filter(left, right, ">=", var_cols, sql, encoder)
        }
        Expression::Less(left, right) => {
            compile_comparison_filter(left, right, "<", var_cols, sql, encoder)
        }
        Expression::LessOrEqual(left, right) => {
            compile_comparison_filter(left, right, "<=", var_cols, sql, encoder)
        }
        Expression::In(needle, haystack) => {
            compile_in_filter(needle, haystack, var_cols, sql, encoder)
        }
        Expression::FunctionCall(Function::StrStarts, args) => {
            compile_strstarts_filter(args, var_cols, sql, encoder)
        }
        Expression::FunctionCall(Function::Contains, args) => {
            compile_contains_filter(args, var_cols, sql, encoder)
        }
        Expression::FunctionCall(Function::StrEnds, args) => {
            compile_strends_filter(args, var_cols, sql, encoder)
        }
        Expression::Bound(var) => {
            if var_cols.contains_key(&var_key(var)) {
                Ok("1".to_string())
            } else {
                Ok("0".to_string())
            }
        }
        Expression::Variable(_)
        | Expression::Literal(_)
        | Expression::NamedNode(_)
        | Expression::FunctionCall(Function::Str, _)
        | Expression::FunctionCall(Function::Concat, _)
        | Expression::FunctionCall(Function::SubStr, _)
        | Expression::FunctionCall(Function::UCase, _)
        | Expression::FunctionCall(Function::LCase, _)
        | Expression::FunctionCall(Function::StrLen, _)
        | Expression::Add(_, _)
        | Expression::Subtract(_, _)
        | Expression::Multiply(_, _)
        | Expression::Divide(_, _)
        | Expression::UnaryPlus(_)
        | Expression::UnaryMinus(_)
        | Expression::If(_, _, _)
        | Expression::Coalesce(_) => Ok(format!(
            "({}) != ''",
            compile_value_expression(expr, var_cols, sql, encoder)?
        )),
        _ => Err(format!(
            "unsupported SPARQL FILTER expression for SQLite compilation: {expr}"
        )),
    }
}

fn compile_boolean_value_expression(
    expr: &Expression,
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    let condition = compile_boolean_expression(expr, var_cols, sql, encoder)?;
    Ok(format!(
        "case when ({condition}) then 'true' else 'false' end"
    ))
}

#[derive(Debug)]
enum SqlOperand {
    Expr(String),
    Const(Vec<String>),
}

fn compile_equality_filter(
    left: &Expression,
    right: &Expression,
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    match (
        expression_operand(left, var_cols, sql, encoder)?,
        expression_operand(right, var_cols, sql, encoder)?,
    ) {
        (SqlOperand::Expr(a), SqlOperand::Expr(b)) => Ok(format!("{a} = {b}")),
        (SqlOperand::Expr(expr), SqlOperand::Const(values))
        | (SqlOperand::Const(values), SqlOperand::Expr(expr)) => {
            Ok(sql.const_values_clause(&expr, &values))
        }
        (SqlOperand::Const(a), SqlOperand::Const(b)) => {
            if a.iter().any(|v| b.contains(v)) {
                Ok("1".to_string())
            } else {
                Ok("0".to_string())
            }
        }
    }
}

fn compile_comparison_filter(
    left: &Expression,
    right: &Expression,
    op: &str,
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    let left = compile_numeric_expression(left, var_cols, sql, encoder)?;
    let right = compile_numeric_expression(right, var_cols, sql, encoder)?;
    Ok(format!("({left}) {op} ({right})"))
}

fn compile_in_filter(
    needle: &Expression,
    haystack: &[Expression],
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    let SqlOperand::Expr(expr) = expression_operand(needle, var_cols, sql, encoder)? else {
        return Err(
            "unsupported SPARQL FILTER IN: left-hand side must be a bound variable or expression"
                .to_string(),
        );
    };
    let mut values = Vec::new();
    for expr in haystack {
        match expression_operand(expr, var_cols, sql, encoder)? {
            SqlOperand::Const(mut v) => values.append(&mut v),
            SqlOperand::Expr(_) => {
                return Err(
                    "unsupported SPARQL FILTER IN: right-hand side variables or expressions are not supported"
                        .to_string(),
                );
            }
        }
    }
    values = dedup(values);
    Ok(sql.const_values_clause(&expr, &values))
}

fn compile_strstarts_filter(
    args: &[Expression],
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    let [haystack, needle] = args else {
        return Err(format!(
            "unsupported SPARQL STRSTARTS arity for SQLite compilation: expected 2 arguments, got {}",
            args.len()
        ));
    };
    let haystack = compile_string_expression(haystack, var_cols, sql, encoder)?;
    let needle = compile_string_expression(needle, var_cols, sql, encoder)?;
    Ok(format!(
        "substr({haystack}, 1, length({needle})) = {needle}"
    ))
}

fn compile_contains_filter(
    args: &[Expression],
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    let [haystack, needle] = args else {
        return Err(format!(
            "unsupported SPARQL CONTAINS arity for SQLite compilation: expected 2 arguments, got {}",
            args.len()
        ));
    };
    let haystack = compile_string_expression(haystack, var_cols, sql, encoder)?;
    let needle = compile_string_expression(needle, var_cols, sql, encoder)?;
    Ok(format!("instr({haystack}, {needle}) > 0"))
}

fn compile_strends_filter(
    args: &[Expression],
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    let [haystack, needle] = args else {
        return Err(format!(
            "unsupported SPARQL STRENDS arity for SQLite compilation: expected 2 arguments, got {}",
            args.len()
        ));
    };
    let haystack = compile_string_expression(haystack, var_cols, sql, encoder)?;
    let needle = compile_string_expression(needle, var_cols, sql, encoder)?;
    Ok(format!(
        "substr({haystack}, length({haystack}) - length({needle}) + 1) = {needle}"
    ))
}

fn quote_sql_string_literal(lexical: &str) -> String {
    let escaped = format!(
        "replace(replace(replace(replace(replace(({lexical}), '\\', '\\\\'), '\"', '\\\"'), char(10), '\\n'), char(13), '\\r'), char(9), '\\t')"
    );
    format!("('\"' || {escaped} || '\"')")
}

fn term_lexical_sql(term: &str) -> String {
    let term = format!("({term})");
    let quoted_body = format!("substr({term}, 2, max(instr(substr({term}, 2), '\"') - 1, 0))");
    let unescaped = format!(
        "replace(replace(replace(replace(replace({quoted_body}, '\\n', char(10)), '\\r', char(13)), '\\t', char(9)), '\\\"', '\"'), '\\\\', '\\')"
    );
    format!(
        "case when substr({term}, 1, 1) = '\"' then {unescaped} when substr({term}, 1, 1) = '<' and substr({term}, -1, 1) = '>' then substr({term}, 2, length({term}) - 2) else {term} end"
    )
}

fn compile_value_expression(
    expr: &Expression,
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    match expr {
        Expression::Variable(var) => var_cols
            .get(&var_key(var))
            .cloned()
            .ok_or_else(|| format!("SPARQL expression variable is not bound in WHERE: {var}")),
        Expression::NamedNode(node) => Ok(sql.push_text(
            encoder
                .values_for_named_node(node)
                .first()
                .map(String::as_str)
                .unwrap_or_else(|| node.as_str()),
        )),
        Expression::Literal(literal) => Ok(sql.push_text(
            encoder
                .values_for_literal(literal)
                .first()
                .map(String::as_str)
                .unwrap_or_else(|| literal.value()),
        )),
        Expression::FunctionCall(Function::Str, args) => {
            let [inner] = args.as_slice() else {
                return Err(format!(
                    "unsupported SPARQL STR arity for SQLite compilation: expected 1 argument, got {}",
                    args.len()
                ));
            };
            let lexical = compile_string_expression(inner, var_cols, sql, encoder)?;
            Ok(quote_sql_string_literal(&lexical))
        }
        Expression::FunctionCall(Function::Concat, args) => {
            let lexical = if args.is_empty() {
                sql.push_text("")
            } else {
                let parts = args
                    .iter()
                    .map(|arg| compile_string_expression(arg, var_cols, sql, encoder))
                    .collect::<Result<Vec<_>, _>>()?;
                format!("({})", parts.join(" || "))
            };
            Ok(quote_sql_string_literal(&lexical))
        }
        Expression::FunctionCall(Function::SubStr, args) => {
            let lexical = compile_substr(args, var_cols, sql, encoder)?;
            Ok(quote_sql_string_literal(&lexical))
        }
        Expression::FunctionCall(Function::UCase, args) => {
            let [inner] = args.as_slice() else {
                return Err(format!(
                    "unsupported SPARQL UCASE arity for SQLite compilation: expected 1 argument, got {}",
                    args.len()
                ));
            };
            let inner = compile_string_expression(inner, var_cols, sql, encoder)?;
            Ok(quote_sql_string_literal(&format!("upper({inner})")))
        }
        Expression::FunctionCall(Function::LCase, args) => {
            let [inner] = args.as_slice() else {
                return Err(format!(
                    "unsupported SPARQL LCASE arity for SQLite compilation: expected 1 argument, got {}",
                    args.len()
                ));
            };
            let inner = compile_string_expression(inner, var_cols, sql, encoder)?;
            Ok(quote_sql_string_literal(&format!("lower({inner})")))
        }
        Expression::FunctionCall(Function::StrLen, args) => {
            let [inner] = args.as_slice() else {
                return Err(format!(
                    "unsupported SPARQL STRLEN arity for SQLite compilation: expected 1 argument, got {}",
                    args.len()
                ));
            };
            let inner = compile_string_expression(inner, var_cols, sql, encoder)?;
            Ok(format!("cast(length({inner}) as text)"))
        }
        Expression::Add(left, right) => {
            compile_arithmetic_expression(left, right, "+", var_cols, sql, encoder)
        }
        Expression::Subtract(left, right) => {
            compile_arithmetic_expression(left, right, "-", var_cols, sql, encoder)
        }
        Expression::Multiply(left, right) => {
            compile_arithmetic_expression(left, right, "*", var_cols, sql, encoder)
        }
        Expression::Divide(left, right) => {
            compile_arithmetic_expression(left, right, "/", var_cols, sql, encoder)
        }
        Expression::UnaryPlus(inner) => {
            compile_numeric_text_expression(inner, var_cols, sql, encoder)
        }
        Expression::UnaryMinus(inner) => {
            let inner = compile_numeric_expression(inner, var_cols, sql, encoder)?;
            Ok(format!("cast(-({inner}) as text)"))
        }
        Expression::If(condition, then_expr, else_expr) => {
            let condition = compile_boolean_expression(condition, var_cols, sql, encoder)?;
            let then_expr = compile_value_expression(then_expr, var_cols, sql, encoder)?;
            let else_expr = compile_value_expression(else_expr, var_cols, sql, encoder)?;
            Ok(format!(
                "case when ({condition}) then ({then_expr}) else ({else_expr}) end"
            ))
        }
        Expression::Coalesce(args) => {
            if args.is_empty() {
                return Err("unsupported SPARQL COALESCE with no arguments".to_string());
            }
            let parts = args
                .iter()
                .map(|arg| compile_value_expression(arg, var_cols, sql, encoder))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("coalesce({})", parts.join(", ")))
        }
        Expression::And(_, _)
        | Expression::Or(_, _)
        | Expression::Not(_)
        | Expression::Equal(_, _)
        | Expression::SameTerm(_, _)
        | Expression::Greater(_, _)
        | Expression::GreaterOrEqual(_, _)
        | Expression::Less(_, _)
        | Expression::LessOrEqual(_, _)
        | Expression::In(_, _)
        | Expression::Bound(_)
        | Expression::FunctionCall(Function::StrStarts, _)
        | Expression::FunctionCall(Function::Contains, _)
        | Expression::FunctionCall(Function::StrEnds, _) => {
            compile_boolean_value_expression(expr, var_cols, sql, encoder)
        }
        _ => Err(format!(
            "unsupported SPARQL expression for SQLite compilation: {expr}"
        )),
    }
}

fn compile_string_expression(
    expr: &Expression,
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    match expr {
        Expression::Variable(var) => var_cols
            .get(&var_key(var))
            .map(|col| term_lexical_sql(col))
            .ok_or_else(|| {
                format!("SPARQL string expression variable is not bound in WHERE: {var}")
            }),
        Expression::Literal(literal) => Ok(sql.push_text(literal.value())),
        Expression::NamedNode(node) => Ok(sql.push_text(node.as_str())),
        Expression::FunctionCall(Function::Str, args) => {
            let [inner] = args.as_slice() else {
                return Err(format!(
                    "unsupported SPARQL STR arity for SQLite compilation: expected 1 argument, got {}",
                    args.len()
                ));
            };
            compile_string_expression(inner, var_cols, sql, encoder)
        }
        Expression::FunctionCall(Function::Concat, args) => {
            if args.is_empty() {
                return Ok(sql.push_text(""));
            }
            let parts = args
                .iter()
                .map(|arg| compile_string_expression(arg, var_cols, sql, encoder))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("({})", parts.join(" || ")))
        }
        Expression::FunctionCall(Function::SubStr, args) => {
            compile_substr(args, var_cols, sql, encoder)
        }
        Expression::FunctionCall(Function::UCase, args) => {
            let [inner] = args.as_slice() else {
                return Err(format!(
                    "unsupported SPARQL UCASE arity for SQLite compilation: expected 1 argument, got {}",
                    args.len()
                ));
            };
            let inner = compile_string_expression(inner, var_cols, sql, encoder)?;
            Ok(format!("upper({inner})"))
        }
        Expression::FunctionCall(Function::LCase, args) => {
            let [inner] = args.as_slice() else {
                return Err(format!(
                    "unsupported SPARQL LCASE arity for SQLite compilation: expected 1 argument, got {}",
                    args.len()
                ));
            };
            let inner = compile_string_expression(inner, var_cols, sql, encoder)?;
            Ok(format!("lower({inner})"))
        }
        Expression::FunctionCall(Function::StrLen, _)
        | Expression::Add(_, _)
        | Expression::Subtract(_, _)
        | Expression::Multiply(_, _)
        | Expression::Divide(_, _)
        | Expression::UnaryPlus(_)
        | Expression::UnaryMinus(_)
        | Expression::If(_, _, _)
        | Expression::Coalesce(_)
        | Expression::And(_, _)
        | Expression::Or(_, _)
        | Expression::Not(_)
        | Expression::Equal(_, _)
        | Expression::SameTerm(_, _)
        | Expression::Greater(_, _)
        | Expression::GreaterOrEqual(_, _)
        | Expression::Less(_, _)
        | Expression::LessOrEqual(_, _)
        | Expression::In(_, _)
        | Expression::Bound(_)
        | Expression::FunctionCall(Function::StrStarts, _)
        | Expression::FunctionCall(Function::Contains, _)
        | Expression::FunctionCall(Function::StrEnds, _) => {
            let term = compile_value_expression(expr, var_cols, sql, encoder)?;
            Ok(term_lexical_sql(&term))
        }
        _ => Err(format!(
            "unsupported SPARQL string expression for SQLite compilation: {expr}"
        )),
    }
}

fn compile_substr(
    args: &[Expression],
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    if args.len() != 2 && args.len() != 3 {
        return Err(format!(
            "unsupported SPARQL SUBSTR arity for SQLite compilation: expected 2 or 3 arguments, got {}",
            args.len()
        ));
    }
    let text = compile_string_expression(&args[0], var_cols, sql, encoder)?;
    let start = compile_numeric_expression(&args[1], var_cols, sql, encoder)?;
    if args.len() == 3 {
        let length = compile_numeric_expression(&args[2], var_cols, sql, encoder)?;
        Ok(format!(
            "substr({text}, cast({start} as integer), cast({length} as integer))"
        ))
    } else {
        Ok(format!("substr({text}, cast({start} as integer))"))
    }
}

fn compile_arithmetic_expression(
    left: &Expression,
    right: &Expression,
    op: &str,
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    let left = compile_numeric_expression(left, var_cols, sql, encoder)?;
    let right = compile_numeric_expression(right, var_cols, sql, encoder)?;
    Ok(format!("cast(({left}) {op} ({right}) as text)"))
}

fn compile_numeric_text_expression(
    expr: &Expression,
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    Ok(format!(
        "cast({} as text)",
        compile_numeric_expression(expr, var_cols, sql, encoder)?
    ))
}

fn compile_numeric_expression(
    expr: &Expression,
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<String, String> {
    match expr {
        Expression::Variable(var) => {
            let key = var_key(var);
            let col = var_cols.get(&key).ok_or_else(|| {
                format!("SPARQL numeric expression variable is not bound in WHERE: {key}")
            })?;
            Ok(format!("cast({} as real)", term_lexical_sql(col)))
        }
        Expression::Literal(literal) if is_numeric_literal(literal, encoder) => {
            Ok(format!("cast({} as real)", sql.push_text(literal.value())))
        }
        Expression::Add(left, right) => {
            let left = compile_numeric_expression(left, var_cols, sql, encoder)?;
            let right = compile_numeric_expression(right, var_cols, sql, encoder)?;
            Ok(format!("({left}) + ({right})"))
        }
        Expression::Subtract(left, right) => {
            let left = compile_numeric_expression(left, var_cols, sql, encoder)?;
            let right = compile_numeric_expression(right, var_cols, sql, encoder)?;
            Ok(format!("({left}) - ({right})"))
        }
        Expression::Multiply(left, right) => {
            let left = compile_numeric_expression(left, var_cols, sql, encoder)?;
            let right = compile_numeric_expression(right, var_cols, sql, encoder)?;
            Ok(format!("({left}) * ({right})"))
        }
        Expression::Divide(left, right) => {
            let left = compile_numeric_expression(left, var_cols, sql, encoder)?;
            let right = compile_numeric_expression(right, var_cols, sql, encoder)?;
            Ok(format!("({left}) / ({right})"))
        }
        Expression::UnaryPlus(inner) => compile_numeric_expression(inner, var_cols, sql, encoder),
        Expression::UnaryMinus(inner) => {
            let inner = compile_numeric_expression(inner, var_cols, sql, encoder)?;
            Ok(format!("-({inner})"))
        }
        _ => Err(format!(
            "unsupported SPARQL numeric expression for SQLite compilation: {expr}"
        )),
    }
}

fn is_numeric_literal(literal: &Literal, encoder: &TermEncoder) -> bool {
    let datatype = literal.datatype();
    let datatype = datatype.as_str();
    let datatype_compact = encoder
        .compact_iri(datatype)
        .unwrap_or_else(|| datatype.to_string());
    matches!(datatype, XSD_INTEGER | XSD_DECIMAL | XSD_DOUBLE | XSD_FLOAT)
        || matches!(
            datatype_compact.as_str(),
            "xsd:integer" | "xsd:decimal" | "xsd:double" | "xsd:float"
        )
}

fn expression_operand(
    expr: &Expression,
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<SqlOperand, String> {
    match expr {
        Expression::NamedNode(node) => Ok(SqlOperand::Const(encoder.values_for_named_node(node))),
        Expression::Literal(literal) => Ok(SqlOperand::Const(encoder.values_for_literal(literal))),
        _ => Ok(SqlOperand::Expr(compile_value_expression(
            expr, var_cols, sql, encoder,
        )?)),
    }
}

fn compile_order(
    order: &[OrderExpression],
    var_cols: &HashMap<String, String>,
    sql: &mut SqlBuilder,
    encoder: &TermEncoder,
) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(order.len());
    for expression in order {
        match expression {
            OrderExpression::Asc(expr) => {
                let compiled = compile_value_expression(expr, var_cols, sql, encoder)?;
                out.push(format!("{compiled} asc"));
            }
            OrderExpression::Desc(expr) => {
                let compiled = compile_value_expression(expr, var_cols, sql, encoder)?;
                out.push(format!("{compiled} desc"));
            }
        }
    }
    Ok(out)
}

fn optimized_pattern_order(patterns: &[Pattern], has_graph_filter: bool) -> Vec<usize> {
    let mut remaining: Vec<_> = (0..patterns.len()).collect();
    let mut bound = HashSet::new();
    let mut order = Vec::with_capacity(patterns.len());
    while !remaining.is_empty() {
        let mut best_pos = 0;
        let mut best_score = usize::MIN;
        for (pos, idx) in remaining.iter().enumerate() {
            let score = pattern_score(&patterns[*idx], has_graph_filter, &bound);
            if score > best_score {
                best_score = score;
                best_pos = pos;
            }
        }
        let idx = remaining.swap_remove(best_pos);
        add_pattern_vars(&patterns[idx], &mut bound);
        order.push(idx);
    }
    order
}

fn pattern_score(pattern: &Pattern, has_graph_filter: bool, bound: &HashSet<String>) -> usize {
    let mut score = 0;
    if has_graph_filter || pattern.graph.as_ref().is_some_and(is_const) {
        score += 12;
    }
    if is_const(&pattern.predicate) {
        score += 10;
    }
    if is_const(&pattern.subject) {
        score += 8;
    }
    if is_const(&pattern.object) {
        score += 6;
    }
    if same_var(&pattern.subject, &pattern.object) {
        score += 2;
    }
    score
        + bound_term_score(pattern.graph.as_ref(), bound)
        + bound_term_score(Some(&pattern.subject), bound)
        + bound_term_score(Some(&pattern.predicate), bound)
        + bound_term_score(Some(&pattern.object), bound)
}

fn bound_term_score(term: Option<&PatternTerm>, bound: &HashSet<String>) -> usize {
    match term {
        Some(PatternTerm::Var(v)) if bound.contains(v) => 16,
        _ => 0,
    }
}

fn add_pattern_vars(pattern: &Pattern, bound: &mut HashSet<String>) {
    for term in [
        pattern.graph.as_ref(),
        Some(&pattern.subject),
        Some(&pattern.predicate),
        Some(&pattern.object),
    ]
    .into_iter()
    .flatten()
    {
        if let PatternTerm::Var(v) = term {
            bound.insert(v.clone());
        }
    }
}

fn is_const(term: &PatternTerm) -> bool {
    matches!(term, PatternTerm::Const(_))
}

fn same_var(a: &PatternTerm, b: &PatternTerm) -> bool {
    matches!((a, b), (PatternTerm::Var(a), PatternTerm::Var(b)) if a == b)
}

fn construct_quads(
    graph_filter: Option<&str>,
    template: &[Pattern],
    rows: &SelectRows,
) -> Vec<[String; 4]> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for row_values in &rows.rows {
        let row = RowBindings {
            vars: &rows.vars,
            values: row_values,
        };
        for p in template {
            let graph = match &p.graph {
                Some(t) => resolve_construct_term(t, &row),
                None => Some(graph_filter.unwrap_or("").to_string()),
            };
            let subject = resolve_construct_term(&p.subject, &row);
            let predicate = resolve_construct_term(&p.predicate, &row);
            let object = resolve_construct_term(&p.object, &row);
            let (Some(graph), Some(subject), Some(predicate), Some(object)) =
                (graph, subject, predicate, object)
            else {
                continue;
            };
            let key = (
                graph.clone(),
                subject.clone(),
                predicate.clone(),
                object.clone(),
            );
            if seen.insert(key) {
                out.push([graph, subject, predicate, object]);
            }
        }
    }
    out
}

struct RowBindings<'a> {
    vars: &'a [String],
    values: &'a [Option<String>],
}

impl RowBindings<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.vars
            .iter()
            .position(|var| var == key)
            .and_then(|idx| self.values.get(idx))
            .and_then(|value| value.as_deref())
    }
}

fn resolve_construct_term(term: &PatternTerm, row: &RowBindings<'_>) -> Option<String> {
    match term {
        PatternTerm::Const(c) => c.primary().map(ToString::to_string),
        PatternTerm::Var(v) => row.get(v).map(ToString::to_string),
    }
}

fn dedup(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(values.len());
    for value in values {
        if seen.insert(value.clone()) {
            out.push(value);
        }
    }
    out
}

fn with_auto_prefixes(query: &str) -> String {
    let tokens = rough_sparql_tokens(query);
    let declared = declared_prefixes(&tokens);
    let used = used_prefixes(&tokens);
    let mut prefixes = String::new();
    for prefix in used.difference(&declared) {
        if prefix.is_empty() {
            continue;
        }
        prefixes.push_str("PREFIX ");
        prefixes.push_str(prefix);
        prefixes.push_str(": <urn:moo-prefix:");
        prefixes.push_str(prefix);
        prefixes.push_str(":>\n");
    }
    if prefixes.is_empty() {
        query.to_string()
    } else {
        prefixes.push_str(query);
        prefixes
    }
}

fn prefix_declarations(query: &str) -> Vec<(String, String)> {
    let chars: Vec<char> = query.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        skip_ws_and_comments(&chars, &mut i);
        let Some(keyword) = read_token(&chars, &mut i) else {
            break;
        };
        if !keyword.eq_ignore_ascii_case("prefix") {
            continue;
        }
        skip_ws_and_comments(&chars, &mut i);
        let Some(label) = read_token(&chars, &mut i) else {
            continue;
        };
        let Some(prefix) = label.strip_suffix(':') else {
            continue;
        };
        if !is_valid_prefix(prefix) {
            continue;
        }
        skip_ws_and_comments(&chars, &mut i);
        if chars.get(i) != Some(&'<') {
            continue;
        }
        i += 1;
        let start = i;
        while i < chars.len() && chars[i] != '>' {
            i += 1;
        }
        if i <= chars.len() {
            let iri: String = chars[start..i.min(chars.len())].iter().collect();
            if !iri.is_empty() {
                out.push((prefix.to_string(), iri));
            }
        }
        if i < chars.len() && chars[i] == '>' {
            i += 1;
        }
    }
    out
}

fn skip_ws_and_comments(chars: &[char], i: &mut usize) {
    while *i < chars.len() {
        if chars[*i].is_whitespace() {
            *i += 1;
            continue;
        }
        if chars[*i] == '#' {
            *i += 1;
            while *i < chars.len() && chars[*i] != '\n' && chars[*i] != '\r' {
                *i += 1;
            }
            continue;
        }
        break;
    }
}

fn read_token(chars: &[char], i: &mut usize) -> Option<String> {
    if *i >= chars.len() || !is_token_start(chars[*i]) {
        return None;
    }
    let start = *i;
    *i += 1;
    while *i < chars.len() && is_token_continue(chars[*i]) {
        *i += 1;
    }
    Some(chars[start..*i].iter().collect())
}

fn declared_prefixes(tokens: &[String]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for pair in tokens.windows(2) {
        if pair[0].eq_ignore_ascii_case("prefix")
            && let Some((prefix, _)) = pair[1].split_once(':')
            && is_valid_prefix(prefix)
        {
            out.insert(prefix.to_string());
        }
    }
    out
}

fn used_prefixes(tokens: &[String]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut previous_was_prefix_keyword = false;
    for token in tokens {
        if previous_was_prefix_keyword {
            previous_was_prefix_keyword = false;
            continue;
        }
        if token.eq_ignore_ascii_case("prefix") {
            previous_was_prefix_keyword = true;
            continue;
        }
        if token.starts_with("_:") || token.contains("://") {
            continue;
        }
        if let Some((prefix, local)) = token.split_once(':')
            && !local.is_empty()
            && is_valid_prefix(prefix)
        {
            out.insert(prefix.to_string());
        }
    }
    out
}

fn rough_sparql_tokens(query: &str) -> Vec<String> {
    let chars: Vec<char> = query.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        if ch == '#' {
            i += 1;
            while i < chars.len() && chars[i] != '\n' && chars[i] != '\r' {
                i += 1;
            }
            continue;
        }
        if ch == '<' {
            i += 1;
            while i < chars.len() {
                if chars[i] == '>' {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            let quote = ch;
            let long = i + 2 < chars.len() && chars[i + 1] == quote && chars[i + 2] == quote;
            i += if long { 3 } else { 1 };
            while i < chars.len() {
                if chars[i] == '\\' {
                    i = (i + 2).min(chars.len());
                    continue;
                }
                if long {
                    if i + 2 < chars.len()
                        && chars[i] == quote
                        && chars[i + 1] == quote
                        && chars[i + 2] == quote
                    {
                        i += 3;
                        break;
                    }
                    i += 1;
                } else if chars[i] == quote {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if is_token_start(ch) {
            let start = i;
            i += 1;
            while i < chars.len() && is_token_continue(chars[i]) {
                i += 1;
            }
            out.push(chars[start..i].iter().collect());
            continue;
        }
        i += 1;
    }
    out
}

fn is_token_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_' || ch == ':'
}

fn is_token_continue(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
        || matches!(
            ch,
            '_' | '-' | ':' | '.' | '%' | '~' | '/' | '#' | '@' | '+'
        )
}

fn is_valid_prefix(prefix: &str) -> bool {
    let mut chars = prefix.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(0);

    fn with_temp_host(test: impl FnOnce() -> Result<(), String>) {
        let dir = std::env::temp_dir().join(format!(
            "moo-sparql-test-{}-{}-{}",
            std::process::id(),
            crate::util::now_ms(),
            NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.sqlite");
        let path_str = path.to_str().unwrap().to_string();
        crate::host::install(&path_str).unwrap();
        let result = test();
        crate::host::drop_host();
        let _ = std::fs::remove_dir_all(&dir);
        result.unwrap();
    }

    fn add(graph: &str, subject: &str, predicate: &str, object: &str) {
        with_host(|h| {
            h.db.execute(
                "insert into quads(ref_name, graph, subject, predicate, object) values ('store', ?1, ?2, ?3, ?4)",
                params![graph, subject, predicate, object],
            )
            .unwrap();
        });
    }

    fn opt_rows(rows: &[&[&str]]) -> Vec<Vec<Option<String>>> {
        rows.iter()
            .map(|row| row.iter().map(|value| Some((*value).to_string())).collect())
            .collect()
    }

    #[test]
    fn filter_strstarts_str_on_graph_variable() {
        with_temp_host(|| {
            add("chat:chat-1", "s", "p", "o1");
            add("chat:other-1", "s", "p", "o2");
            add("chat:chat-2", "s", "p", "o3");

            let rows = match run_sparql(
                r#"select ?g ?o where { graph ?g { ?s ?p ?o } filter(strstarts(str(?g), "chat:chat-")) } order by ?g"#,
                "store",
                None,
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(rows.vars, vec!["?g".to_string(), "?o".to_string()]);
            assert_eq!(
                rows.rows,
                opt_rows(&[&["chat:chat-1", "o1"], &["chat:chat-2", "o3"]])
            );
            Ok(())
        });
    }

    #[test]
    fn filter_strstarts_accepts_direct_variable() {
        with_temp_host(|| {
            add("g", "chat:chat-1", "p", "yes");
            add("g", "note:1", "p", "no");

            let rows = match run_sparql(
                r#"select ?s where { ?s ?p ?o filter(strstarts(?s, "chat:chat-")) }"#,
                "store",
                None,
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(rows.rows, opt_rows(&[&["chat:chat-1"]]));
            Ok(())
        });
    }

    #[test]
    fn bind_and_select_expressions_compile_to_sql() {
        with_temp_host(|| {
            add("g", "thing:1", "rdfs:label", "\"Alpha\"");
            add("g", "thing:2", "rdfs:label", "\"Beta\"");

            let rows = match run_sparql(
                r#"select ?s (concat(str(?label), "!") as ?excited) where {
                    ?s rdfs:label ?label
                    bind(strlen(str(?label)) as ?len)
                    filter(?len > 4)
                } order by desc(?excited)"#,
                "store",
                None,
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(rows.vars, vec!["?s".to_string(), "?excited".to_string()]);
            assert_eq!(rows.rows, opt_rows(&[&["thing:1", "\"Alpha!\""]]));
            Ok(())
        });
    }

    #[test]
    fn select_expression_without_graph_pattern() {
        with_temp_host(|| {
            let rows = match run_sparql(
                r#"select (concat("hello", " world") as ?label) where {}"#,
                "store",
                None,
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(rows.vars, vec!["?label".to_string()]);
            assert_eq!(rows.rows, opt_rows(&[&["\"hello world\""]]));
            Ok(())
        });
    }

    #[test]
    fn filter_contains_strends_and_numeric_comparisons() {
        with_temp_host(|| {
            add("g", "item:1", "rdfs:label", "\"Alpha\"");
            add("g", "item:1", "schema:score", "7");
            add("g", "item:2", "rdfs:label", "\"Alpine\"");
            add("g", "item:2", "schema:score", "3");
            add("g", "item:3", "rdfs:label", "\"Beta\"");
            add("g", "item:3", "schema:score", "9");

            let rows = match run_sparql(
                r#"select ?s where {
                    ?s rdfs:label ?label ; schema:score ?score
                    filter(contains(str(?label), "Al") && strends(str(?label), "a") && (?score + 1) >= 8)
                }"#,
                "store",
                None,
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(rows.rows, opt_rows(&[&["item:1"]]));
            Ok(())
        });
    }

    #[test]
    fn union_merges_branch_rows() {
        with_temp_host(|| {
            add("g", "item:1", "rdf:type", "schema:Thing");
            add("g", "item:2", "rdf:type", "schema:Other");

            let rows = match run_sparql(
                r#"select ?s where {
                    { ?s rdf:type schema:Thing }
                    union
                    { ?s rdf:type schema:Other }
                } order by ?s"#,
                "store",
                Some("g"),
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(rows.rows, opt_rows(&[&["item:1"], &["item:2"]]));
            Ok(())
        });
    }

    #[test]
    fn union_leaves_branch_only_variables_unbound() {
        with_temp_host(|| {
            add("g", "item:1", "schema:name", "\"Alpha\"");
            add("g", "item:2", "schema:score", "7");

            let rows = match run_sparql(
                r#"select ?s ?name ?score where {
                    { ?s schema:name ?name }
                    union
                    { ?s schema:score ?score }
                } order by ?s"#,
                "store",
                Some("g"),
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(
                rows.rows,
                vec![
                    vec![
                        Some("item:1".to_string()),
                        Some("\"Alpha\"".to_string()),
                        None
                    ],
                    vec![Some("item:2".to_string()), None, Some("7".to_string())],
                ]
            );
            Ok(())
        });
    }

    #[test]
    fn minus_filters_matching_rows() {
        with_temp_host(|| {
            add("g", "item:1", "rdf:type", "schema:Thing");
            add("g", "item:2", "rdf:type", "schema:Thing");
            add("g", "item:2", "schema:hidden", "true");

            let rows = match run_sparql(
                r#"select ?s where {
                    ?s rdf:type schema:Thing
                    minus { ?s schema:hidden true }
                }"#,
                "store",
                Some("g"),
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(rows.rows, opt_rows(&[&["item:1"]]));
            Ok(())
        });
    }

    #[test]
    fn values_blocks_restrict_and_bind_variables() {
        with_temp_host(|| {
            add("g", "item:1", "rdfs:label", "\"Alpha\"");
            add("g", "item:2", "rdfs:label", "\"Beta\"");
            add("g", "item:3", "rdfs:label", "\"Gamma\"");

            let rows = match run_sparql(
                r#"select ?s ?label where {
                    values ?s { item:1 item:3 }
                    ?s rdfs:label ?label
                } order by ?s"#,
                "store",
                Some("g"),
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(
                rows.rows,
                opt_rows(&[&["item:1", "\"Alpha\""], &["item:3", "\"Gamma\""]])
            );
            Ok(())
        });
    }

    #[test]
    fn values_undef_leaves_variable_unbound() {
        with_temp_host(|| {
            let rows = match run_sparql(
                r#"select ?s ?label where {
                    values (?s ?label) { (item:1 "Alpha") (item:2 UNDEF) }
                } order by ?s"#,
                "store",
                None,
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(
                rows.rows,
                vec![
                    vec![Some("item:1".to_string()), Some("\"Alpha\"".to_string())],
                    vec![Some("item:2".to_string()), None],
                ]
            );
            Ok(())
        });
    }

    #[test]
    fn optional_left_join_returns_unbound_rows() {
        with_temp_host(|| {
            add("g", "person:1", "rdf:type", "schema:Person");
            add("g", "person:1", "schema:name", "\"Ada\"");
            add("g", "person:2", "rdf:type", "schema:Person");

            let rows = match run_sparql(
                r#"select ?s ?name where {
                    ?s rdf:type schema:Person
                    optional { ?s schema:name ?name }
                } order by ?s"#,
                "store",
                Some("g"),
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(rows.vars, vec!["?s".to_string(), "?name".to_string()]);
            assert_eq!(
                rows.rows,
                vec![
                    vec![Some("person:1".to_string()), Some("\"Ada\"".to_string())],
                    vec![Some("person:2".to_string()), None],
                ]
            );
            Ok(())
        });
    }

    #[test]
    fn optional_left_join_expression_filters_only_optional_side() {
        with_temp_host(|| {
            add("g", "person:1", "rdf:type", "schema:Person");
            add("g", "person:1", "schema:name", "\"Ada\"");
            add("g", "person:2", "rdf:type", "schema:Person");
            add("g", "person:2", "schema:name", "\"Bob\"");

            let rows = match run_sparql(
                r#"select ?s ?name where {
                    ?s rdf:type schema:Person
                    optional { ?s schema:name ?name filter(strstarts(str(?name), "Ad")) }
                } order by ?s"#,
                "store",
                Some("g"),
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(
                rows.rows,
                vec![
                    vec![Some("person:1".to_string()), Some("\"Ada\"".to_string())],
                    vec![Some("person:2".to_string()), None],
                ]
            );
            Ok(())
        });
    }

    #[test]
    fn construct_can_use_bind_expression() {
        with_temp_host(|| {
            add("derived", "item:1", "rdfs:label", "\"Alpha\"");

            let quads = match run_sparql(
                r#"construct { ?s schema:name ?name } where {
                    ?s rdfs:label ?label
                    bind(concat(str(?label), "!") as ?name)
                }"#,
                "store",
                Some("derived"),
                None,
            )? {
                SparqlResult::Construct(quads) => quads,
                _ => unreachable!(),
            };

            assert_eq!(
                quads,
                vec![[
                    "derived".to_string(),
                    "item:1".to_string(),
                    "schema:name".to_string(),
                    "\"Alpha!\"".to_string(),
                ]]
            );
            Ok(())
        });
    }
    #[test]
    fn group_by_counts_rows_per_group() {
        with_temp_host(|| {
            add("g", "person:1", "schema:knows", "person:2");
            add("g", "person:1", "schema:knows", "person:3");
            add("g", "person:2", "schema:knows", "person:3");

            let rows = match run_sparql(
                r#"select ?s (count(?o) as ?count) where {
                    ?s schema:knows ?o
                } group by ?s order by ?s"#,
                "store",
                Some("g"),
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(rows.vars, vec!["?s".to_string(), "?count".to_string()]);
            assert_eq!(
                rows.rows,
                opt_rows(&[&["person:1", "2"], &["person:2", "1"]])
            );
            Ok(())
        });
    }

    #[test]
    fn aggregates_without_group_return_single_row() {
        with_temp_host(|| {
            add("g", "s1", "schema:score", "1");
            add("g", "s2", "schema:score", "3");

            let rows = match run_sparql(
                r#"select (count(*) as ?count) (sum(?score) as ?sum) (avg(?score) as ?avg)
                   where { ?s schema:score ?score }"#,
                "store",
                Some("g"),
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(rows.rows.len(), 1);
            assert_eq!(rows.rows[0][0], Some("2".to_string()));
            assert_eq!(rows.rows[0][1], Some("4.0".to_string()));
            assert_eq!(rows.rows[0][2], Some("2.0".to_string()));
            Ok(())
        });
    }

    #[test]
    fn group_by_having_filters_aggregated_rows() {
        with_temp_host(|| {
            add("g", "person:1", "schema:knows", "person:2");
            add("g", "person:1", "schema:knows", "person:3");
            add("g", "person:2", "schema:knows", "person:3");

            let rows = match run_sparql(
                r#"select ?s (count(*) as ?count) where {
                    ?s schema:knows ?o
                } group by ?s having(count(*) > 1)"#,
                "store",
                Some("g"),
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(rows.rows, opt_rows(&[&["person:1", "2"]]));
            Ok(())
        });
    }

    #[test]
    fn group_concat_uses_separator() {
        with_temp_host(|| {
            add("g", "person:1", "rdfs:label", "\"Ada\"");
            add("g", "person:1", "rdfs:label", "\"Lovelace\"");

            let rows = match run_sparql(
                r#"select ?s (group_concat(str(?label); separator=", ") as ?labels) where {
                    ?s rdfs:label ?label
                } group by ?s"#,
                "store",
                Some("g"),
                None,
            )? {
                SparqlResult::Select(rows) => rows,
                _ => unreachable!(),
            };

            assert_eq!(rows.rows.len(), 1);
            assert_eq!(rows.rows[0][0], Some("person:1".to_string()));
            assert_eq!(rows.rows[0][1], Some("\"Ada, Lovelace\"".to_string()));
            Ok(())
        });
    }
}
