const userAgent = process.env.npm_config_user_agent ?? ''

if (!userAgent.startsWith('pnpm/')) {
  console.error(
    'Publish @uselatch/sdk with pnpm. npm publish leaves workspace:* in the packed manifest, and installs fail.'
  )
  console.error(`npm_config_user_agent=${userAgent || '(unset)'}`)
  process.exit(1)
}
