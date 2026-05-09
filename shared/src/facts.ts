export type RdfTerm = string | { termType?: string; value: string; datatype?: string; language?: string };

export type Triple = {
  subject: RdfTerm;
  predicate: RdfTerm;
  object: RdfTerm;
  graph?: RdfTerm;
};
