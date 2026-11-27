// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { acceptedRows, parseProblem, parseStatus, problemTitle, submissionLanguage } from '../adapters/boj';

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

test('selects only the signed-in user\'s accepted rows in supported languages', () => {
  const row = { submissionId: '1', accountContext: 'alice', problemId: 1330, rawVerdict: '맞았습니다!!',
    language: 'Python 3', submittedAt: null, memoryKb: null, executionTimeMs: null };
  const rows = [row, { ...row, submissionId: '2', accountContext: 'bob' }, { ...row, submissionId: '3', rawVerdict: '틀렸습니다' },
    { ...row, submissionId: '4', language: 'PyPy3' }, { ...row, submissionId: '5', language: 'Rust 2021' }];
  expect(acceptedRows(rows, 'alice').map((item) => item.submissionId)).toEqual(['1', '5']);
  const stamped = (id: string, submittedAt: string | null, rawVerdict = '맞았습니다!!') => ({ ...row, submissionId: id, submittedAt, rawVerdict });
  const since = Date.parse('2026-11-27T08:00:00.000Z');
  expect(acceptedRows([
    stamped('10', '2026-11-27T07:59:59.999Z'), stamped('11', '2026-11-27T08:00:00.000Z'), stamped('12', '2026-11-28T00:00:00.000Z'),
    stamped('13', null), stamped('14', '2026-11-28T00:00:00.000Z', 'Accepted'), stamped('15', '2026-11-28T00:00:00.000Z', '틀렸습니다'),
  ], 'alice', since).map((item) => item.submissionId)).toEqual(['11', '12', '14']);
  expect(problemTitle('<span id="problem_title"> 두 수 비교하기 </span>')).toBe('두 수 비교하기');
  expect(problemTitle('<p>login</p>')).toBeNull();
});

test('accepts only GitHub repository names that can be created', async () => {
  Object.assign(globalThis, { __SUPER_BOJ_GITHUB_CLIENT_ID__: 'test', __SUPER_BOJ_GITHUB_APP_SLUG__: 'test' });
  const { validRepositoryName } = await import('../adapters/github');
  expect(['boj-solutions', 'BOJ_2026', 'a.b'].every(validRepositoryName)).toBe(true);
  expect(['', '.', '..', 'name.git', 'has space', 'ㄱ', 'x'.repeat(101)].some(validRepositoryName)).toBe(false);
});
