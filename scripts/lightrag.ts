import { LightRAGWorkerClient } from '../services/knowledge-service/src/lightrag/lightrag-worker-client.js'

const args = process.argv.slice(2)
const commandArguments = args[0] === '--' ? args.slice(1) : args
const command = commandArguments[0]
if (command !== 'health' || commandArguments.length !== 1) showUsage()

const result = await new LightRAGWorkerClient().health()
process.stdout.write([
  'LightRAG runtime: OK',
  `Package: ${result.package}`,
  `Version: ${result.version}`,
  `Python: ${result.pythonVersion}`,
  `Working directory: ${result.workingDir}`,
  '',
].join('\n'))

function showUsage(): never {
  throw new Error('Usage: pnpm lightrag -- health')
}
