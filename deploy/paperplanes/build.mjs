import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Template } from 'e2b'

try { loadEnvFile('.env') } catch (error) { if (error.code !== 'ENOENT') throw error }
const context = resolve('.deploy/baselayer-build')
mkdirSync(context, { recursive: true })
const source = resolve(process.env.SCRY_SOURCE ?? '../Desktop/scry')
execFileSync('tar', ['--no-xattrs', '--exclude=._*', '--exclude=node_modules', '--exclude=target', '--exclude=.git', '--exclude=.env*', '-czf', resolve(context, 'scry-source.tar.gz'), '-C', source, 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'daemon', 'server', 'docs', 'README.md'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
for (const file of ['prepare.sh', 'boot.sh', 'scry.sh']) copyFileSync(resolve(fileURLToPath(new URL('.', import.meta.url)), file), resolve(context, file))
const template = Template({ fileContextPath: context })
  .fromImage('node:22-bookworm')
  .setUser('root')
  .copy('scry-source.tar.gz', '/tmp/scry-source.tar.gz')
  .copy('prepare.sh', '/tmp/prepare-baselayer.sh')
  .copy('boot.sh', '/opt/baselayer-test/boot.sh')
  .copy('scry.sh', '/opt/baselayer-test/scry.sh')
  .runCmd('bash /tmp/prepare-baselayer.sh')
  .setStartCmd('bash /opt/baselayer-test/boot.sh', 'curl -fsS http://127.0.0.1:3000/health && curl -fsS http://127.0.0.1:4000/health && docker info >/dev/null')
const result = await Template.build(template, 'baselayer-scry', {
  cpuCount: 2, memoryMB: 4096, minFreeDiskMb: 8192,
  onBuildLogs: (entry) => console.log(entry.toString()),
})
writeFileSync('.deploy/baselayer-template.json', JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
