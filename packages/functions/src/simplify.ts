import { Document, Primitive, PropertyType, Transform, TransformContext } from '@gltf-transform/core';
import {
	createTransform,
	formatDeltaOp,
	deepListAttributes,
	remapAttribute,
	deepSwapAttribute,
	isTransformPending,
	shallowCloneAccessor,
} from './utils.js';
import { weld } from './weld.js';
import type { MeshoptSimplifier } from 'meshoptimizer';
import { dedup } from './dedup.js';
import { prune } from './prune.js';
import { dequantizeAttributeArray } from './dequantize.js';
import { unweldPrimitive } from './unweld.js';

const NAME = 'simplify';

/** Options for the {@link simplify} function. */
export interface SimplifyOptions {
	/** MeshoptSimplifier instance. */
	simplifier: unknown;
	/** Target ratio (0–1) of vertices to keep. Default: 0.0 (0%). */
	ratio?: number;
	/** Limit on error, as a fraction of mesh radius. Default: 0.0001 (0.01%). */
	error?: number;
	/**
	 * Whether to lock topological borders of the mesh. May be necessary when
	 * adjacent 'chunks' of a large mesh (e.g. terrain) share a border, helping
	 * to ensure no seams appear.
	 */
	lockBorder?: boolean;
}

export const SIMPLIFY_DEFAULTS: Required<Omit<SimplifyOptions, 'simplifier'>> = {
	ratio: 0.0,
	error: 0.0001,
	lockBorder: false,
};

/**
 * Simplification algorithm, based on meshoptimizer, producing meshes with fewer
 * triangles and vertices. Simplification is lossy, but the algorithm aims to
 * preserve visual quality as much as possible for given parameters.
 *
 * The algorithm aims to reach the target 'ratio', while minimizing error. If
 * error exceeds the specified 'error' threshold, the algorithm will quit
 * before reaching the target ratio. Examples:
 *
 * - ratio=0.0, error=0.0001: Aims for maximum simplification, constrained to 0.01% error.
 * - ratio=0.5, error=0.0001: Aims for 50% simplification, constrained to 0.01% error.
 * - ratio=0.5, error=1: Aims for 50% simplification, unconstrained by error.
 *
 * Topology, particularly split vertices, will also limit the simplifier. For
 * best results, apply a {@link weld} operation before simplification.
 *
 * Example:
 *
 * ```javascript
 * import { simplify, weld } from '@gltf-transform/functions';
 * import { MeshoptSimplifier } from 'meshoptimizer';
 *
 * await document.transform(
 *   weld({ tolerance: 0.0001 }),
 *   simplify({ simplifier: MeshoptSimplifier, ratio: 0.75, error: 0.001 })
 * );
 * ```
 *
 * References:
 * - https://github.com/zeux/meshoptimizer/blob/master/js/README.md#simplifier
 *
 * @category Transforms
 */
export function simplify(_options: SimplifyOptions): Transform {
	const options = { ...SIMPLIFY_DEFAULTS, ..._options } as Required<SimplifyOptions>;

	const simplifier = options.simplifier as typeof MeshoptSimplifier | undefined;

	if (!simplifier) {
		throw new Error(`${NAME}: simplifier dependency required — install "meshoptimizer".`);
	}

	return createTransform(NAME, async (document: Document, context?: TransformContext): Promise<void> => {
		const logger = document.getLogger();

		await simplifier.ready;
		await document.transform(weld({ overwrite: false }));

		// Simplify mesh primitives.
		for (const mesh of document.getRoot().listMeshes()) {
			for (const prim of mesh.listPrimitives()) {
				if (prim.getMode() === Primitive.Mode.TRIANGLES) {
					simplifyPrimitive(document, prim, options);
					if (prim.getIndices()!.getCount() === 0) prim.dispose();
				} else if (prim.getMode() === Primitive.Mode.POINTS && !!simplifier.simplifyPoints) {
					simplifyPrimitive(document, prim, options);
					if (prim.getAttribute('POSITION')!.getCount() === 0) prim.dispose();
				} else {
					logger.warn(`${NAME}: Skipping primitive of mesh "${mesh.getName()}": Unsupported draw mode.`);
				}
			}

			if (mesh.listPrimitives().length === 0) mesh.dispose();
		}

		// Where simplification removes meshes, we may need to prune leaf nodes.
		await document.transform(
			prune({
				propertyTypes: [PropertyType.ACCESSOR, PropertyType.NODE],
				keepAttributes: true,
				keepIndices: true,
				keepLeaves: false,
			}),
		);

		// Where multiple primitive indices point into the same vertex streams, simplification
		// may write duplicate streams. Find and remove the duplicates after processing.
		if (!isTransformPending(context, NAME, 'dedup')) {
			await document.transform(dedup({ propertyTypes: [PropertyType.ACCESSOR] }));
		}

		logger.debug(`${NAME}: Complete.`);
	});
}

export function simplifyPrimitive(document: Document, prim: Primitive, _options: SimplifyOptions): Primitive {
	const options = { ...SIMPLIFY_DEFAULTS, ..._options } as Required<SimplifyOptions>;
	const simplifier = options.simplifier as typeof MeshoptSimplifier;

	if (prim.getMode() === Primitive.Mode.POINTS) {
		return _simplifyPoints(document, prim, options);
	}

	const logger = document.getLogger();
	const position = prim.getAttribute('POSITION')!;
	const srcIndices = prim.getIndices()!;
	const srcIndexCount = srcIndices.getCount();
	const srcVertexCount = position.getCount();

	let positionArray = position.getArray()!;
	let indicesArray = srcIndices.getArray()!;

	// (1) Gather attributes and indices in Meshopt-compatible format.

	if (!(positionArray instanceof Float32Array)) {
		positionArray = dequantizeAttributeArray(positionArray, position.getComponentType(), position.getNormalized());
	}
	if (!(indicesArray instanceof Uint32Array)) {
		indicesArray = new Uint32Array(indicesArray);
	}

	// (2) Run simplification.

	const targetCount = Math.floor((options.ratio * srcIndexCount) / 3) * 3;
	const flags = options.lockBorder ? ['LockBorder'] : [];

	const [dstIndicesArray, error] = simplifier.simplify(
		indicesArray,
		positionArray,
		3,
		targetCount,
		options.error,
		flags as 'LockBorder'[],
	);

	const [remap, unique] = simplifier.compactMesh(dstIndicesArray);

	logger.debug(`${NAME}: ${formatDeltaOp(position.getCount(), unique)} vertices, error: ${error.toFixed(4)}.`);

	// (3) Write vertex attributes.

	for (const srcAttribute of deepListAttributes(prim)) {
		const dstAttribute = shallowCloneAccessor(document, srcAttribute);
		remapAttribute(dstAttribute, remap, unique);
		deepSwapAttribute(prim, srcAttribute, dstAttribute);
		if (srcAttribute.listParents().length === 1) srcAttribute.dispose();
	}

	// (4) Write indices.

	const dstIndices = shallowCloneAccessor(document, srcIndices);
	dstIndices.setArray(srcVertexCount <= 65534 ? new Uint16Array(dstIndicesArray) : dstIndicesArray);
	prim.setIndices(dstIndices);
	if (srcIndices.listParents().length === 1) srcIndices.dispose();

	return prim;
}

function _simplifyPoints(document: Document, prim: Primitive, options: Required<SimplifyOptions>): Primitive {
	const simplifier = options.simplifier as typeof MeshoptSimplifier;
	const logger = document.getLogger();

	const indices = prim.getIndices();
	if (indices) unweldPrimitive(prim);

	const position = prim.getAttribute('POSITION')!;
	const color = prim.getAttribute('COLOR_0');
	const srcVertexCount = position.getCount();

	let positionArray = position.getArray()!;
	let colorArray = color ? color.getArray()! : undefined;
	const colorStride = color ? color.getComponentSize() : undefined;

	// (1) Gather attributes in Meshopt-compatible format.

	if (!(positionArray instanceof Float32Array)) {
		positionArray = dequantizeAttributeArray(positionArray, position.getComponentType(), position.getNormalized());
	}
	if (colorArray && !(colorArray instanceof Float32Array)) {
		colorArray = dequantizeAttributeArray(colorArray, position.getComponentType(), position.getNormalized());
	}

	// (2) Run simplification.

	simplifier.useExperimentalFeatures = true;
	const targetCount = Math.floor(options.ratio * srcVertexCount);
	const dstIndicesArray = simplifier.simplifyPoints(positionArray, 3, targetCount, colorArray, colorStride);
	simplifier.useExperimentalFeatures = false;

	// (3) Write vertex attributes.

	const [remap, unique] = simplifier.compactMesh(dstIndicesArray);

	logger.debug(`${NAME}: ${formatDeltaOp(position.getCount(), unique)} vertices.`);

	for (const srcAttribute of deepListAttributes(prim)) {
		const dstAttribute = shallowCloneAccessor(document, srcAttribute);
		remapAttribute(dstAttribute, remap, unique);
		deepSwapAttribute(prim, srcAttribute, dstAttribute);
		if (srcAttribute.listParents().length === 1) srcAttribute.dispose();
	}

	return prim;
}
