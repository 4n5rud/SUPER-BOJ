// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { parseProblem } from '../adapters/boj';

test('reads only a matched pair of samples from an official problem page', () => {
  document.body.innerHTML = '<span id="problem_title">Test</span><pre id="sample-input-1">1 2\n</pre><pre id="sample-output-1">3\n</pre>';
  expect(parseProblem(document, 'https://acmicpc.net/problem/1000')).toMatchObject({
    problemId: 1000, title: 'Test', samples: [{ id: '1', input: '1 2\n', expectedOutput: '3\n' }],
  });
  expect(parseProblem(document, 'https://acmicpc.net.example/problem/1000')).toBeNull();
  document.querySelector('#sample-output-1')?.remove();
  expect(() => parseProblem(document, 'https://acmicpc.net/problem/1000')).toThrow();
});
