import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CORNERS, EDGE, Grid } from '../public/js/shared/hex.js';

const grid = new Grid(13, 9);

test('neighbours are symmetric and one step away', () => {
  for (let i = 0; i < grid.N; i++) {
    for (let d = 0; d < 6; d++) {
      const n = grid.neighbor(i, d);
      if (n < 0) continue;
      assert.equal(grid.neighbor(n, (d + 3) % 6), i, `tile ${i} dir ${d}`);
      assert.equal(grid.distance(i, n), 1);
      assert.equal(grid.dirTo(i, n), d);
    }
  }
});

test('interior tiles have full rings', () => {
  const i = grid.index(6, 4);
  assert.equal(grid.neighbors(i).length, 6);
  assert.equal(grid.within(i, 1).length, 7);
  assert.equal(grid.within(i, 2).length, 19);
  assert.equal(grid.within(i, 1)[0], i);
  for (const t of grid.within(i, 2)) assert.ok(grid.distance(i, t) <= 2);
});

test('pixel centres round-trip to their tiles', () => {
  for (const size of [1, 17.5, 32]) {
    for (let i = 0; i < grid.N; i++) {
      const [x, y] = grid.center(i, size);
      assert.equal(grid.fromPixel(x, y, size), i);
      // A point well inside the hex (60% of the way to a corner) stays in it.
      for (const [cx, cy] of CORNERS) assert.equal(grid.fromPixel(x + cx * size * 0.6, y + cy * size * 0.6, size), i);
    }
  }
  assert.equal(grid.fromPixel(-100, -100, 10), -1);
});

test('each edge faces the neighbour in its direction', () => {
  const size = 10;
  const i = grid.index(5, 3);
  const [x, y] = grid.center(i, size);
  for (let d = 0; d < 6; d++) {
    const [a, b] = EDGE[d];
    const mx = x + ((CORNERS[a][0] + CORNERS[b][0]) / 2) * size;
    const my = y + ((CORNERS[a][1] + CORNERS[b][1]) / 2) * size;
    // Step just past the edge midpoint: we should be in the neighbour.
    const px = x + (mx - x) * 1.2;
    const py = y + (my - y) * 1.2;
    assert.equal(grid.fromPixel(px, py, size), grid.neighbor(i, d), `direction ${d}`);
  }
});

test('lines are contiguous and end where asked', () => {
  for (const [a, b] of [
    [0, grid.N - 1],
    [grid.index(2, 7), grid.index(11, 1)],
    [grid.index(4, 4), grid.index(4, 4)],
  ]) {
    const line = grid.line(a, b);
    assert.equal(line[0], a);
    assert.equal(line[line.length - 1], b);
    assert.equal(line.length, grid.distance(a, b) + 1);
    for (let k = 1; k < line.length; k++) assert.equal(grid.distance(line[k - 1], line[k]), 1);
  }
});
