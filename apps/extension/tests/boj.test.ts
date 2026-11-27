// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { parseProblem, parseStatus, submissionLanguage } from '../adapters/boj';

test('reads only a matched pair of samples from an official problem page', () => {
  document.body.innerHTML = '<span id="problem_title">Test</span><pre id="sample-input-1">1 2\n</pre><pre id="sample-output-1">3\n</pre>';
  expect(parseProblem(document, 'https://acmicpc.net/problem/1000')).toMatchObject({
    problemId: 1000, title: 'Test', samples: [{ id: '1', input: '1 2\n', expectedOutput: '3\n' }],
  });
  expect(parseProblem(document, 'https://acmicpc.net.example/problem/1000')).toBeNull();
  document.querySelector('#sample-output-1')?.remove();
  expect(() => parseProblem(document, 'https://acmicpc.net/problem/1000')).toThrow();
});

test('matches supported BOJ language labels to the corresponding profiles', () => {
  expect(['Rust 2021', 'Rust', 'C11', 'C++17', 'Python 3', 'Java 11'].map(submissionLanguage))
    .toEqual(['rust', 'rust', 'c', 'cpp', 'python', 'java']);
  expect(['PyPy3', 'C++20', 'Java 8', 'Kotlin'].map(submissionLanguage))
    .toEqual([undefined, undefined, undefined, undefined]);
});

test('reads reordered status columns and a language with a source action label', () => {
  document.body.innerHTML = `<table id="status-table">
    <thead><tr><th>Submission #</th><th>Problem</th><th>Level</th><th>User</th><th>Language</th>
      <th>Result</th><th>Memory (KB)</th><th>Time (ms)</th><th>Submitted</th></tr></thead>
    <tbody><tr><td>123</td><td><a href="/problem/1330">1330</a></td><td>Bronze</td>
      <td><a href="/user/Alice">Alice</a></td><td><a href="/source/123">Rust 2021</a> / Edit</td>
      <td><span>맞았습니다!!</span></td><td>1024</td><td>12</td><td><a data-timestamp="1700000000">just now</a></td>
    </tr></tbody></table>`;
  expect(parseStatus(document, 'https://www.acmicpc.net/status?user_id=alice')).toEqual([{
    submissionId: '123', accountContext: 'alice', problemId: 1330, rawVerdict: '맞았습니다!!',
    memoryKb: 1024, executionTimeMs: 12, language: 'Rust 2021', submittedAt: '2023-11-14T22:13:20.000Z',
  }]);
  expect(parseStatus(document, 'https://www.acmicpc.net/status?contest_id=1')).toBeNull();
});
