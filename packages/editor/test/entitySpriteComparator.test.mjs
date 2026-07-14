import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { URL } from 'node:url'

const entitySpriteSource = readFileSync(
    new URL('../src/containers/EntitySprite.ts', import.meta.url),
    'utf8'
).replaceAll('\r\n', '\n')
const blueprintContainerSource = readFileSync(
    new URL('../src/containers/BlueprintContainer.ts', import.meta.url),
    'utf8'
).replaceAll('\r\n', '\n')

function extractMethodBody(source, declaration) {
    const start = source.indexOf(declaration)
    assert.ok(start >= 0, `${declaration} should exist`)
    const openingBrace = source.indexOf('{', start)
    let depth = 0
    for (let index = openingBrace; index < source.length; index++) {
        if (source[index] === '{') depth++
        if (source[index] !== '}') continue
        depth--
        if (depth === 0) return source.slice(openingBrace + 1, index)
    }
    assert.fail(`${declaration} should have a balanced closing brace`)
}

const renderBandGetter = new Function(
    extractMethodBody(entitySpriteSource, 'public get renderBand')
)
const groundRailPrivateOrder = new Function(
    'sourceIndex',
    extractMethodBody(entitySpriteSource, 'private static groundRailPrivateZIndex')
)
const compare = new Function(
    'a',
    'b',
    extractMethodBody(entitySpriteSource, 'public static compareFn')
)

function record(label, renderBand, y, sourceOrder, x, id) {
    return {
        label,
        renderBand: renderBandGetter.call({ _renderBand: renderBand }),
        __zIndex: groundRailPrivateOrder(sourceOrder),
        entityPos: { x, y },
        zOrder: sourceOrder,
        id,
    }
}

function legacyStitchedLabels(partCount) {
    const sourceOrders = Array.from({ length: partCount }, (_, sourceOrder) => sourceOrder)
    const buckets = [
        sourceOrders.filter(sourceOrder => sourceOrder < 2),
        sourceOrders.filter(sourceOrder => sourceOrder >= 2 && sourceOrder < 4),
        sourceOrders.filter(sourceOrder => sourceOrder >= 4),
    ]
    return buckets.flatMap(bucket => [
        ...bucket.map(sourceOrder => `near-${sourceOrder}`),
        ...bucket.map(sourceOrder => `far-${sourceOrder}`),
    ])
}

test('ground rail private order stays stitched to legacy flattened source indices', () => {
    const ordinaryBands = [
        'ground-rail-underlay',
        'ground-rail-underlay',
        'ground-rail-structure',
        'ground-rail-structure',
        'ground-rail-foreground',
    ]
    const scenarios = [
        { name: 'ordinary five-part rail', bands: ordinaryBands },
        {
            name: 'cardinal gate six-part rail',
            bands: [...ordinaryBands, 'ground-rail-foreground'],
        },
        {
            name: 'layered ten-part rail',
            bands: ordinaryBands.flatMap(renderBand => [renderBand, renderBand]),
        },
    ]

    for (const { name, bands } of scenarios) {
        const stitched = [
            ...bands.map((renderBand, sourceOrder) =>
                record(`far-${sourceOrder}`, renderBand, 10, sourceOrder, 0, 100 + sourceOrder)
            ),
            ...bands.map((renderBand, sourceOrder) =>
                record(`near-${sourceOrder}`, renderBand, 0, sourceOrder, 0, sourceOrder)
            ),
        ].reverse()

        assert.deepEqual(
            stitched.sort(compare).map(item => item.label),
            legacyStitchedLabels(bands.length),
            name
        )
    }

    assert.match(
        entitySpriteSource,
        /else if \(sprite\.renderBand !== undefined\) \{\s*sprite\.__zIndex = EntitySprite\.groundRailPrivateZIndex\(i\)\s*\}/
    )
})

test('within a band the comparator remains Y, source order, X, stable ID', () => {
    const band = 'ground-rail-underlay'
    const sorted = [
        record('stable-id-last', band, 1, 0, 1, 2),
        record('high-y-high-x', band, 1, 0, 1, 1),
        record('low-y-high-source', band, 0, 1, 0, 1),
        record('high-y-low-x', band, 1, 0, 0, 1),
        record('low-y-low-source', band, 0, 0, 9, 1),
    ].sort(compare)
    assert.deepEqual(
        sorted.map(item => item.label),
        ['low-y-low-source', 'low-y-high-source', 'high-y-low-x', 'high-y-high-x', 'stable-id-last']
    )
})

test('the public accessor is semantic or undefined and never returns private order', () => {
    assert.equal(
        renderBandGetter.call({ _renderBand: 'ground-rail-foreground' }),
        'ground-rail-foreground'
    )
    assert.equal(renderBandGetter.call({ _renderBand: undefined }), undefined)
    const getterSource = extractMethodBody(entitySpriteSource, 'public get renderBand')
    assert.doesNotMatch(getterSource, /return\s+this\.__zIndex/)
    assert.doesNotMatch(entitySpriteSource, /public\s+(?:get\s+)?(?:__zIndex|zIndex)/)
    assert.doesNotMatch(blueprintContainerSource, /(?:zIndex|__zIndex|numericPriority)\s*:/)
    assert.match(entitySpriteSource, /this\._renderBand\s*=\s*data\.renderBand/)
})
