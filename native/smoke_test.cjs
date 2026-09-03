// Round-trip sanity check for the native addon: build a tiny HNSW index,
// load it, and confirm a query returns its own nearest point first.
const native = require('./build/Release/starmemory_native.node');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dim = 8;
const n = 50;

function randomUnitVector(dim) {
  const v = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

const vectors = new Float32Array(n * dim);
const ids = new BigInt64Array(n);
for (let i = 0; i < n; i++) {
  const v = randomUnitVector(dim);
  vectors.set(v, i * dim);
  ids[i] = BigInt(1000 + i); // custom row ids, deliberately not 0..n-1
}

const outputPath = path.join(os.tmpdir(), `starmemory-smoke-${Date.now()}`);
const options = { dim, metric: 'cosine', isVectorNormed: true, M: 16, efConstruction: 40, efSearch: 64 };

console.log('Building index at', outputPath);
native.buildHnswIndex(options, vectors, ids, outputPath);
console.log('Build OK');

const searcher = new native.HnswSearcher(options, outputPath);
console.log('Load OK');

// Query with the exact vector for row 10 (custom id 1010) -- it should come
// back as its own nearest neighbor with score ~1.0 (cosine of a vector with itself).
const queryIdx = 10;
const query = vectors.slice(queryIdx * dim, queryIdx * dim + dim);
const result = searcher.search(query, 5);

console.log('Query result ids:', Array.from(result.ids));
console.log('Query result distances:', Array.from(result.distances));

if (result.ids[0] !== 1010n) {
  console.error(`FAIL: expected first result id 1010n, got ${result.ids[0]}`);
  process.exit(1);
}
if (Math.abs(result.distances[0] - 1.0) > 1e-4) {
  console.error(`FAIL: expected top score ~1.0, got ${result.distances[0]}`);
  process.exit(1);
}

// Filtered search: restrict to a subset that excludes id 1010 -- the top
// result should change, proving the id_filter path actually gates results.
const filterIds = new BigInt64Array([1005n, 1006n, 1007n]);
const filtered = searcher.search(query, 5, filterIds);
console.log('Filtered result ids:', Array.from(filtered.ids));
if (filtered.ids.some((id) => id === 1010n)) {
  console.error('FAIL: filtered search returned an id outside the filter set');
  process.exit(1);
}
if (!filtered.ids.every((id) => filterIds.includes(id))) {
  console.error('FAIL: filtered search returned an id outside the filter set');
  process.exit(1);
}

console.log('ALL CHECKS PASSED');
fs.rmSync(outputPath, { recursive: true, force: true });
