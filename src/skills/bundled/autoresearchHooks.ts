import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { EXAMPLES_README, SKILL_MD } from './autoresearchHooksContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Author pre/post-iteration hooks for an autoresearch session.'

const SKILL_FILES: Record<string, string> = {
  'examples/README.md': EXAMPLES_README,
}

export function registerAutoresearchHooksSkill(): void {
  registerBundledSkill({
    name: 'autoresearch-hooks',
    description: DESCRIPTION,
    userInvocable: true,
    files: SKILL_FILES,
    async getPromptForCommand(args) {
      const parts: string[] = [SKILL_BODY.trimStart()]
      if (args) {
        parts.push(`## User Request\n\n${args}`)
      }
      return [{ type: 'text', text: parts.join('\n\n') }]
    },
  })
}
