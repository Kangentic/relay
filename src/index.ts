import { main } from './main.js';

main().catch((error: unknown) => {
  console.error('fatal error starting relay', error);
  process.exit(1);
});
