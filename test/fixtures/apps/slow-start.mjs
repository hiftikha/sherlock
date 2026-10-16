const waitMs = Number(process.env.WAIT_MS ?? 300);
const burnMs = Number(process.env.BURN_MS ?? 400);
const leakMb = Number(process.env.LEAK_MB ?? 0);
const lifeMs = Number(process.env.LIFE_MS ?? 2500);

console.log('booting');
await new Promise((r) => setTimeout(r, waitMs));
const end = Date.now() + burnMs;
let x = 0;
while (Date.now() < end) x += Math.sqrt(x + 1);
const keep = [];
if (leakMb) keep.push(Buffer.alloc(leakMb * 1024 * 1024, 1));
console.log(`READY ${x > 0}`);
process.stdin.resume?.();
process.on('SIGUSR2', () => keep.push(Buffer.alloc(8 * 1024 * 1024, 2)));
setTimeout(() => process.exit(0), lifeMs);
