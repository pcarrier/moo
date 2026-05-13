import type { ApiCommand } from "./contract";
import type { Skill, SkillFrontmatter, SkillRefreshResult, SkillSaveInput, SkillSummary } from "./types";

export type SkillDownloadResult = {
  url: string;
  content: string;
  frontmatter: SkillFrontmatter;
  frontmatterRaw: string;
  name?: string;
};

export type SkillContext = { chatId?: string | null; root?: string | null };

export type SkillCommands =
  | ApiCommand<"skills-list", { enabled?: boolean } & SkillContext, { skills: SkillSummary[] }>
  | ApiCommand<"skill-get", { id: string } & SkillContext, { skill: Skill | null }>
  | ApiCommand<"skill-download", { url: string; timeoutMs?: number }, SkillDownloadResult>
  | ApiCommand<"skill-save", SkillSaveInput, { skill: Skill }>
  | ApiCommand<"skill-remove", { id: string }, { id: string; removed: boolean }>
  | ApiCommand<"skill-refresh", { id: string; timeoutMs?: number } & SkillContext, SkillRefreshResult>;
