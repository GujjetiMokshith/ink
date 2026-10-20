import test, {type TestContext} from 'node:test';
import React from 'react';
import chalk from 'chalk';
import Output, {OutputCaches, outputCaches} from '../src/output.js';
import {Box, Text, renderToString} from '../src/index.js';

test('OutputCaches caches line widths and evicts oldest after maxSize (4096)', (t: TestContext) => {
	const caches = new OutputCaches();

	const firstWidth = caches.getStringWidth('test-string-first');
	t.assert.strictEqual(firstWidth, 17);
	t.assert.strictEqual(caches.widths.has('test-string-first'), true);

	// Repeated call returns cached value
	t.assert.strictEqual(caches.getStringWidth('test-string-first'), 17);

	// Insert entries to trigger eviction (QuickLRU evicts from both internal maps after 2 * maxSize = 8192)
	for (let index = 0; index < 8192; index++) {
		caches.getStringWidth(`test-width-${index}`);
	}

	t.assert.strictEqual(caches.widths.has('test-string-first'), false);
});

test('OutputCaches getWidestLine delegates to measureText and returns block width', (t: TestContext) => {
	const caches = new OutputCaches();

	const firstWidth = caches.getWidestLine('hello\nworld!');
	t.assert.strictEqual(firstWidth, 6);

	// Repeated call returns cached value from measureText
	t.assert.strictEqual(caches.getWidestLine('hello\nworld!'), 6);
});

test('OutputCaches caches styled characters for single lines and evicts oldest after maxSize (512)', (t: TestContext) => {
	const caches = new OutputCaches();

	const firstChars = caches.getStyledChars('styled-line-first');
	t.assert.strictEqual(firstChars.length, 17);
	t.assert.strictEqual(caches.styledChars.has('styled-line-first'), true);

	// Repeated call returns the exact same array reference
	t.assert.strictEqual(caches.getStyledChars('styled-line-first'), firstChars);

	// Insert entries to trigger eviction (2 * maxSize = 1024)
	for (let index = 0; index < 1024; index++) {
		caches.getStyledChars(`styled-line-${index}`);
	}

	t.assert.strictEqual(caches.styledChars.has('styled-line-first'), false);
});

test('OutputCaches does not cache whole multiline blocks in styledChars to prevent heap blowup', (t: TestContext) => {
	const caches = new OutputCaches();
	const multiline = 'line one\nline two\nline three';

	const parsed = caches.getStyledChars(multiline);
	// Parsed tokens contain the newlines
	t.assert.strictEqual(
		parsed.some(char => char.value === '\n'),
		true,
	);
	// Whole multiline block must NOT be stored in styledChars
	t.assert.strictEqual(caches.styledChars.has(multiline), false);
});

test('OutputCaches clear() resets caches', (t: TestContext) => {
	const caches = new OutputCaches();

	caches.getStringWidth('line');
	caches.getStyledChars('styled');

	t.assert.strictEqual(caches.widths.size > 0, true);
	t.assert.strictEqual(caches.styledChars.size > 0, true);

	caches.clear();

	t.assert.strictEqual(caches.widths.size, 0);
	t.assert.strictEqual(caches.styledChars.size, 0);
});

test('Output instances share default outputCaches across instances and frames', (t: TestContext) => {
	outputCaches.clear();

	const output1 = new Output({width: 10, height: 2});
	t.assert.strictEqual(output1.caches, outputCaches);

	output1.write(0, 0, 'hello shared cache', {transformers: []});
	output1.get();

	t.assert.strictEqual(
		outputCaches.styledChars.has('hello shared cache'),
		true,
	);

	const output2 = new Output({width: 10, height: 2});
	t.assert.strictEqual(output2.caches, outputCaches);
	t.assert.strictEqual(
		output2.caches.styledChars.has('hello shared cache'),
		true,
	);
});

test('Output accepts custom caches for isolation', (t: TestContext) => {
	const customCaches = new OutputCaches();
	const output = new Output({width: 10, height: 2, caches: customCaches});

	t.assert.strictEqual(output.caches, customCaches);
	t.assert.notStrictEqual(output.caches, outputCaches);
});

test('horizontal clip fast path returns line unchanged when it fits inside clip', (t: TestContext) => {
	const output = new Output({width: 20, height: 2});
	const line = 'fitting text';
	const lineWidth = output.caches.getStringWidth(line);

	// When from === 0 and to >= width, sliceLineToColumns returns original line string reference
	const result = output.sliceLineToColumns(line, 0, lineWidth + 5);
	t.assert.strictEqual(result, line);

	const exactResult = output.sliceLineToColumns(line, 0, lineWidth);
	t.assert.strictEqual(exactResult, line);
});

test('horizontal clip path correctly slices lines that exceed the clip window', (t: TestContext) => {
	const output = new Output({width: 20, height: 2});
	const line = 'abcdefghij';

	t.assert.strictEqual(output.sliceLineToColumns(line, 2, 6), 'cdef');
	t.assert.strictEqual(output.sliceLineToColumns(line, 5, 2), '');
});

test('horizontal clipping in Output write operations uses fast path for fitting lines', (t: TestContext) => {
	const output = new Output({width: 20, height: 3});

	// Clip from x=2 to x=15
	output.clip({x1: 2, x2: 15, y1: 0, y2: 3});
	// Line placed at x=2, width 5 (ends at x=7 <= 15). from === 0, to === 5 >= width
	output.write(2, 0, 'hello', {transformers: []});
	// Line placed at x=0, width 10 (clip x1=2 means from=2, clipped!)
	output.write(0, 1, '0123456789', {transformers: []});
	output.unclip();

	const rendered = output.get();
	const lines = rendered.output.split('\n');

	t.assert.strictEqual(lines[0], '  hello');
	t.assert.strictEqual(lines[1], '  23456789');
});

test('render-node-to-output routes widestLine through measureText', (t: TestContext) => {
	const text = 'line one\nlonger line two\nline three';
	const rendered = renderToString(
		<Box width={30}>
			<Text>{text}</Text>
		</Box>,
	);

	t.assert.strictEqual(rendered, text);
});

test('regression: multiline updates with changing status row cache per-line without retaining multiline blocks', (t: TestContext) => {
	outputCaches.clear();

	const stableRow1 = 'stable row 1: static content';
	const stableRow2 = 'stable row 2: another static row';

	for (let frame = 0; frame < 5; frame++) {
		const statusRow = `status at frame ${frame}`;
		const fullBlock = `${stableRow1}\n${stableRow2}\n${statusRow}`;

		const output = new Output({width: 40, height: 3});
		output.write(0, 0, fullBlock, {transformers: []});
		const result = output.get();

		t.assert.strictEqual(
			result.output,
			`${stableRow1}\n${stableRow2}\n${statusRow}`,
		);

		// The whole multiline block should NOT be in styledChars
		t.assert.strictEqual(outputCaches.styledChars.has(fullBlock), false);
	}

	// Stable individual rows MUST be cached in styledChars
	t.assert.strictEqual(outputCaches.styledChars.has(stableRow1), true);
	t.assert.strictEqual(outputCaches.styledChars.has(stableRow2), true);
});

test('styles spanning newlines in multiline blocks still work correctly across frames', (t: TestContext) => {
	const originalLevel = chalk.level;
	chalk.level = 3;
	t.after(() => {
		chalk.level = originalLevel;
	});

	// Text with ANSI red opened on line 1 and closed on line 2
	const redMultiline = chalk.red('line 1\nline 2');

	const output1 = renderToString(<Text>{redMultiline}</Text>);
	const expected = `${chalk.red('line 1')}\n${chalk.red('line 2')}`;
	t.assert.strictEqual(output1, expected);

	// Second render reuses individual lines and produces identical output
	const output2 = renderToString(<Text>{redMultiline}</Text>);
	t.assert.strictEqual(output2, expected);
});
