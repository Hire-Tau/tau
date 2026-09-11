import { resolve } from 'node:path'

type CapturedOrders = { schemaVersion: 1; orders: Array<{ name: string; files: string[] }> }
const webRoot = resolve(import.meta.dir, '..')
const fixture = (await Bun.file(
  resolve(import.meta.dir, 'loginpage-captured-order-projections.json')
).json()) as CapturedOrders
const loginTest = 'src/components/LoginPage.test.tsx'
const voiceTest = 'src/components/VoiceWorkspacePage.test.tsx'
const expectedInventory = (await Bun.file(resolve(webRoot, 'test-baseline.json')).json()) as { files: string[] }
const expectedInventoryBeforeRegressionFiles = expectedInventory.files.filter(
  (file) =>
    !file.endsWith('LoginPage.voiceWorkspaceIsolation.test.tsx') &&
    !file.endsWith('persistentDomMutationIsolation.test.ts')
)
const expectPoison = Bun.argv.includes('--expect-poison')
const requestedOrder = Bun.argv.find((argument) => argument.startsWith('pr-'))
const orders = requestedOrder ? fixture.orders.filter((order) => order.name === requestedOrder) : fixture.orders
if (fixture.schemaVersion !== 1 || fixture.orders.length !== 2 || (requestedOrder && orders.length !== 1)) {
  throw new Error('invalid captured-order projection selection')
}

for (const order of orders) {
  if (order.files.length !== 146 || new Set(order.files).size !== order.files.length) {
    throw new Error(`${order.name}: expected 146 unique captured files`)
  }
  if ([...order.files].sort().join('\n') !== [...expectedInventoryBeforeRegressionFiles].sort().join('\n')) {
    throw new Error(`${order.name}: captured inventory differs from the preserved 146-file inventory`)
  }
  const voiceIndex = order.files.indexOf(voiceTest)
  const loginIndex = order.files.indexOf(loginTest)
  if (voiceIndex < 0 || loginIndex <= voiceIndex) throw new Error(`${order.name}: invalid Voice/Login indices`)
  const projection = order.files.slice(voiceIndex, loginIndex + 1)
  const child = Bun.spawn(['bun', 'test', ...projection], { cwd: webRoot, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const output = `${stdout}\n${stderr}`
  const headings = [...output.matchAll(/^(src\/[^:\r\n]+\.(?:test|spec)\.tsx?):/gm)].map((match) => match[1])
  if (headings.join('\n') !== projection.join('\n')) {
    process.stderr.write(output)
    throw new Error(`${order.name}: Bun emitted ${headings.join(' -> ')}, expected ${projection.join(' -> ')}`)
  }
  if (expectPoison) {
    const loginFailures = new Set(
      [...output.matchAll(/\(fail\) LoginPage auth modes > ([^\r\n[]+)/g)].map((match) => match[1].trim())
    )
    const hashTraces = output.match(/window\.location\.hash/g)?.length ?? 0
    const poisonPostconditionFailed = output.includes(
      '(fail) VoiceWorkspacePage artifacts > renders without replacing the process browser environment'
    )
    if (exitCode === 0 || !poisonPostconditionFailed || loginFailures.size !== 10 || hashTraces < 10) {
      process.stderr.write(output)
      throw new Error(
        `${order.name}: expected active Voice poison, 10 distinct LoginPage failures, and >=10 hash traces; got ${poisonPostconditionFailed}/${loginFailures.size}/${hashTraces}`
      )
    }
    console.log(
      `${order.name}: poison active through ${projection.join(' -> ')}; 10 distinct LoginPage failures, ${hashTraces} hash traces`
    )
  } else {
    if (exitCode !== 0) {
      process.stderr.write(output)
      throw new Error(`${order.name}: fixed causal projection failed`)
    }
    console.log(`${order.name}: fixed causal projection passed: ${projection.join(' -> ')}`)
  }
}
