import { CUSTOM_SKILLS } from './custom-skills';

/**
 * A skill that is managed externally (e.g. user-installed) and needs
 * permission grants but is NOT installed by this plugin's CLI.
 */
export interface PermissionOnlySkill {
  /** Skill name — must match the name OpenCode uses for permission checks */
  name: string;
  /** List of agents that should auto-allow this skill */
  allowedAgents: string[];
  /** Human-readable description (for documentation only) */
  description: string;
}

/**
 * Skills managed externally (not installed by this plugin's CLI).
 * Entries here only affect agent permission grants — nothing is installed.
 */
export const PERMISSION_ONLY_SKILLS: PermissionOnlySkill[] = [
  {
    name: 'requesting-code-review',
    allowedAgents: ['oracle'],
    description:
      'Code review template for reviewer subagents in multi-step workflows',
  },
];

/**
 * Get permission presets for a specific agent based on bundled skills.
 * @param agentName - The name of the agent
 * @param skillList - Optional explicit list of skills to allow (overrides defaults)
 * @returns Permission rules for the skill permission type
 */
export function getSkillPermissionsForAgent(
  agentName: string,
  skillList?: string[],
  disabledSkillNames?: string[],
): Record<string, 'allow' | 'ask' | 'deny'> {
  const disabledSkills = new Set(disabledSkillNames ?? []);

  // Orchestrator gets all skills by default, others are restricted
  const permissions: Record<string, 'allow' | 'ask' | 'deny'> = {
    '*': agentName === 'orchestrator' ? 'allow' : 'deny',
  };

  // If the user provided an explicit skill list (even empty), honor it
  if (skillList) {
    permissions['*'] = 'deny';
    for (const name of skillList) {
      if (name === '*') {
        permissions['*'] = 'allow';
      } else if (name.startsWith('!')) {
        permissions[name.slice(1)] = 'deny';
      } else if (!disabledSkills.has(name)) {
        permissions[name] = 'allow';
      }
    }
    for (const name of disabledSkills) {
      permissions[name] = 'deny';
    }

    // Reviewer agents always get book-rules, even when user provides an
    // explicit skill list (the user's list is a floor, not a ceiling).
    const REVIEWER_AGENTS = new Set(['oracle', 'council', 'councillor']);
    if (REVIEWER_AGENTS.has(agentName)) {
      const BOOK_RULES_SKILLS = [
        'book-rules/clean-code',
        'book-rules/clean-architecture',
        'book-rules/refactoring',
        'book-rules/working-effectively-with-legacy-code',
        'book-rules/a-philosophy-of-software-design',
        'book-rules/domain-driven-design',
        'book-rules/designing-data-intensive-applications',
        'book-rules/release-it',
        'book-rules/the-pragmatic-programmer',
      ];
      for (const name of BOOK_RULES_SKILLS) {
        if (!disabledSkills.has(name)) {
          permissions[name] = 'allow';
        }
      }
    }

    return permissions;
  }

  // Apply permissions from bundled custom skills
  for (const skill of CUSTOM_SKILLS) {
    const isAllowed =
      skill.allowedAgents.includes('*') ||
      skill.allowedAgents.includes(agentName);
    if (isAllowed && !disabledSkills.has(skill.name)) {
      permissions[skill.name] = 'allow';
    }
  }

  // Apply permissions for externally-managed skills (not installed by this plugin)
  for (const skill of PERMISSION_ONLY_SKILLS) {
    const isAllowed =
      skill.allowedAgents.includes('*') ||
      skill.allowedAgents.includes(agentName);
    if (isAllowed && !disabledSkills.has(skill.name)) {
      permissions[skill.name] = 'allow';
    }
  }

  for (const name of disabledSkills) {
    permissions[name] = 'deny';
  }

  // Review agents (oracle, council, councillor) need book-rules skills
  // for architecture review, code quality assessment, and refactoring guidance.
  // These are external skills installed by the user, so they must be
  // explicitly allowlisted here instead of relying on the default '*' wildcard.
  const REVIEWER_AGENTS = new Set(['oracle', 'council', 'councillor']);
  if (REVIEWER_AGENTS.has(agentName)) {
    const BOOK_RULES_SKILLS = [
      'book-rules/clean-code',
      'book-rules/clean-architecture',
      'book-rules/refactoring',
      'book-rules/working-effectively-with-legacy-code',
      'book-rules/a-philosophy-of-software-design',
      'book-rules/domain-driven-design',
      'book-rules/designing-data-intensive-applications',
      'book-rules/release-it',
      'book-rules/the-pragmatic-programmer',
    ];
    for (const name of BOOK_RULES_SKILLS) {
      if (!disabledSkills.has(name)) {
        permissions[name] = 'allow';
      }
    }
  }

  return permissions;
}
