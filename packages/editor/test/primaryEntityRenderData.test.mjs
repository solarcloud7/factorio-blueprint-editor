import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const entityContainerSource = readFileSync(
    new URL('../src/containers/EntityContainer.ts', import.meta.url),
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
    assert.ok(openingBrace >= 0, `${declaration} should have a body`)

    let depth = 0
    for (let index = openingBrace; index < source.length; index++) {
        if (source[index] === '{') depth++
        if (source[index] !== '}') continue
        depth--
        if (depth === 0) return source.slice(openingBrace + 1, index)
    }
    assert.fail(`${declaration} should have a balanced closing brace`)
}

test('EntityContainer exposes a defensive copy of its composed render sprites', () => {
    const body = extractMethodBody(entityContainerSource, 'public getRenderSprites')
    const getRenderSprites = new Function(body) // eslint-disable-line no-new-func
    const sprites = [
        { id: 'underlay', renderBand: 'ground-rail-underlay' },
        { id: 'structure', renderBand: 'ground-rail-structure' },
        { id: 'foreground', renderBand: 'ground-rail-foreground' },
    ]

    const result = getRenderSprites.call({ entitySprites: sprites })

    assert.deepEqual(
        result.map((sprite, sourceOrder) => ({ id: sprite.id, sourceOrder })),
        [
            { id: 'underlay', sourceOrder: 0 },
            { id: 'structure', sourceOrder: 1 },
            { id: 'foreground', sourceOrder: 2 },
        ]
    )
    assert.deepEqual(
        result.map(sprite => sprite.renderBand),
        ['ground-rail-underlay', 'ground-rail-structure', 'ground-rail-foreground']
    )
    assert.notEqual(result, sprites, 'callers must not mutate EntityContainer ownership')
    assert.equal(result[0], sprites[0], 'sprite records remain the composed public objects')
})

test('BlueprintContainer resolves composed sprites and pixel origin by entity number', () => {
    const body = extractMethodBody(blueprintContainerSource, 'public getEntityRenderData')
    const getEntityRenderData = new Function('EntityContainer', 'entityNumber', body) // eslint-disable-line no-new-func
    const sprites = [
        { id: 'underlay', renderBand: 'ground-rail-underlay' },
        { id: 'foreground', renderBand: 'ground-rail-foreground' },
    ]
    const entity = {
        position: { x: 48, y: 80 },
        getRenderSprites: () => [...sprites],
    }
    const EntityContainer = { mappings: new Map([[7, entity]]) }

    const result = getEntityRenderData(EntityContainer, 7)
    assert.deepEqual(result.origin, { x: 48, y: 80 })
    assert.deepEqual(
        result.sprites.map((sprite, sourceOrder) => ({
            id: sprite.id,
            renderBand: sprite.renderBand,
            sourceOrder,
        })),
        [
            { id: 'underlay', renderBand: 'ground-rail-underlay', sourceOrder: 0 },
            { id: 'foreground', renderBand: 'ground-rail-foreground', sourceOrder: 1 },
        ]
    )
    assert.notEqual(result.sprites, sprites)
    assert.equal(result.sprites[0], sprites[0])
    assert.equal(getEntityRenderData(EntityContainer, 99), undefined)
})
