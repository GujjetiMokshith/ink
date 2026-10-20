import test, {type TestContext} from 'node:test';
import React from 'react';
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

test('OutputCaches caches block widths and evicts oldest after maxSize (512)', (t: TestContext) => {
	const caches = new OutputCaches();

	const firstWidth = caches.getWidestLine('hello\nworld!');
	t.assert.strictEqual(firstWidth, 6);
	t.assert.strictEqual(caches.blockWidths.has('hello\nworld!'), true);
	// Line widths are also populated in `widths`
	t.assert.strictEqual(caches.widths.has('hello'), true);
	t.assert.strictEqual(caches.widths.has('world!'), true);

	// Repeated call returns cached value
	t.assert.strictEqual(caches.getWidestLine('hello\nworld!'), 6);

	// Insert entries to trigger eviction (2 * maxSize = 1024)
	for (let index = 0; index < 1024; index++) {
		caches.getWidestLine(`block-${index}\nline2`);
	}

	t.assert.strictEqual(caches.blockWidths.has('hello\nworld!'), false);
});

test('OutputCaches caches styled characters and evicts oldest after maxSize (512)', (t: TestContext) => {
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

test('OutputCaches clear() resets all three caches', (t: TestContext) => {
	const caches = new OutputCaches();

	caches.getStringWidth('line');
	caches.getWidestLine('block');
	caches.getStyledChars('styled');

	t.assert.strictEqual(caches.widths.size > 0, true);
	t.assert.strictEqual(caches.blockWidths.size > 0, true);
	t.assert.strictEqual(caches.styledChars.size > 0, true);

	caches.clear();

	t.assert.strictEqual(caches.widths.size, 0);
	t.assert.strictEqual(caches.blockWidths.size, 0);
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

test('render-node-to-output routes widestLine through shared cache', (t: TestContext) => {
	outputCaches.clear();

	const text = 'line one\nlonger line two\nline three';
	renderToString(
		<Box width={30}>
			<Text>{text}</Text>
		</Box>,
	);

	// Block width should be cached in outputCaches
	t.assert.strictEqual(outputCaches.blockWidths.has(text), true);
	t.assert.strictEqual(outputCaches.blockWidths.get(text), 15);

	// Each individual line width should also be cached
	t.assert.strictEqual(outputCaches.widths.has('line one'), true);
	t.assert.strictEqual(outputCaches.widths.has('longer line two'), true);
	t.assert.strictEqual(outputCaches.widths.has('line three'), true);
});
