import fs from 'fs';
const pipe = 'AGENTS.md';

function readPipe() {
  const stream = fs.createReadStream(pipe);
  stream.on('data', (chunk) => {});
  stream.on('end', () => {});
}

// Warm up
for(let i=0; i<5; i++) readPipe();

const start = Date.now();
for(let i=0; i<10; i++) readPipe();
console.log(`Node read: ${Date.now() - start}ms`);
