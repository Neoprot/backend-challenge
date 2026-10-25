import { testEnvironment } from '../test/support/environment';

// Validação antes de iniciar qualquer teste que possa modificar recursos.
testEnvironment();
const preflight = Bun.spawn([process.execPath, 'test', './test/integration/environment.test.ts', '--timeout', '60000'], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
});
const preflightExit = await preflight.exited;
if (preflightExit !== 0) process.exit(preflightExit);
const suite = Bun.spawn([process.execPath, 'test', './test/integration', '--timeout', '60000'], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
});
process.exit(await suite.exited);
