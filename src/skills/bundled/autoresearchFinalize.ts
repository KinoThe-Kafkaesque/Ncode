import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { FINALIZE_SH, SKILL_MD } from './autoresearchFinalizeContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Finalize an autoresearch session into clean, reviewable branches.'

const CONTEXT = frontmatter.context === 'fork' ? 'fork' : undefined

const SKILL_FILES: Record<string, string> = {
  'finalize.sh': FINALIZE_SH,
}

export function registerAutoresearchFinalizeSkill(): void {
  registerBundledSkill({
    name: 'autoresearch-finalize',
    description: DESCRIPTION,
    userInvocable: true,
    context: CONTEXT,
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
