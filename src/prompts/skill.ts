export function skillPrompt(): string {
  return `# Skill workflow

\`crtr\` ships skills — markdown reference with frontmatter that you pull on
demand. When the user's task matches a skill's description, run
\`crtr skill show <name>\` and apply the guidance. Ambiguous names exit \`4\` —
disambiguate with \`<plugin>:<name>\`.

## Discover

\`\`\`
crtr skill list                    # one per line: <scope>:<plugin>/<name>  — <description>
crtr skill search <query>          # rank by name, description, keywords
crtr skill grep <pattern>          # regex search across SKILL.md bodies
\`\`\`

## Load

\`\`\`
crtr skill show <name>             # print SKILL.md body to stdout
crtr skill show <plugin>:<name>    # disambiguate when names collide
crtr skill path <name>             # absolute path to SKILL.md
crtr skill where <name>            # {scope, plugin, path} as JSON
\`\`\`

\`show\` is the default verb: \`crtr skill <name>\` (with no verb) also prints
the body.

## Author

\`\`\`
crtr skill new <plugin>:<name> --description "..."   # scaffold a new skill
crtr skill show authoring-skills                     # the SKILL.md authoring guide
\`\`\`

## Toggle

\`\`\`
crtr skill enable <name>           # clear any disable in the chosen scope
crtr skill disable <name>          # hide from list and agent discovery
\`\`\`

## Exit codes

- \`0\` — success
- \`3\` — skill not found
- \`4\` — ambiguous name; use \`<plugin>:<name>\`
`;
}
