/**
 * Terse constructors for node definitions.
 *
 * Node authoring should be mostly declaration. Anything a definition repeats —
 * the shape of a slider, the standard "input terrain" port, the way a mask
 * blends a result back over its input — lives here so the node files stay
 * readable as a catalog rather than as code.
 */

import {
  cloneField,
  createField,
  lerpFields,
  type Field,
} from '@terrasmith/core';
import type { EnumOption, EvalContext, ParamDef, PortDef, PortValue } from '../types.js';

/** A number parameter with a slider. */
export function num(
  id: string,
  label: string,
  def: number,
  options: Partial<Omit<ParamDef, 'id' | 'label' | 'type' | 'default'>> = {},
): ParamDef {
  return { id, label, type: 'number', default: def, tier: 'basic', ...options };
}

/** An integer parameter. */
export function int(
  id: string,
  label: string,
  def: number,
  options: Partial<Omit<ParamDef, 'id' | 'label' | 'type' | 'default'>> = {},
): ParamDef {
  return { id, label, type: 'int', default: def, step: 1, tier: 'basic', ...options };
}

/** A checkbox. */
export function bool(
  id: string,
  label: string,
  def: boolean,
  options: Partial<Omit<ParamDef, 'id' | 'label' | 'type' | 'default'>> = {},
): ParamDef {
  return { id, label, type: 'boolean', default: def, tier: 'basic', ...options };
}

/** A dropdown. */
export function choice(
  id: string,
  label: string,
  def: string,
  options: EnumOption[],
  extra: Partial<Omit<ParamDef, 'id' | 'label' | 'type' | 'default' | 'options'>> = {},
): ParamDef {
  return { id, label, type: 'enum', default: def, options, tier: 'basic', ...extra };
}

/**
 * A seed. Separated from a plain integer because the UI gives it a dice button,
 * and because "try another seed" is the single most useful action a beginner
 * has.
 */
export function seedParam(id = 'seed', label = 'Seed'): ParamDef {
  return {
    id,
    label,
    type: 'seed',
    default: 0,
    step: 1,
    description:
      'Changes the random pattern without changing its character. Reroll this to get a different ' +
      'version of the same kind of terrain.',
    tier: 'basic',
  };
}

/** A distance parameter measured in elmos, BAR's world unit. */
export function elmos(
  id: string,
  label: string,
  def: number,
  options: Partial<Omit<ParamDef, 'id' | 'label' | 'type' | 'default' | 'unit'>> = {},
): ParamDef {
  return {
    id,
    label,
    type: 'number',
    default: def,
    unit: 'elmos',
    min: 0,
    tier: 'basic',
    ...options,
  };
}

/** An angle in degrees. */
export function degrees(
  id: string,
  label: string,
  def: number,
  options: Partial<Omit<ParamDef, 'id' | 'label' | 'type' | 'default' | 'unit'>> = {},
): ParamDef {
  return {
    id,
    label,
    type: 'number',
    default: def,
    unit: '°',
    min: 0,
    max: 90,
    step: 0.5,
    tier: 'basic',
    ...options,
  };
}

/** The standard terrain input port. */
export function terrainIn(id = 'terrain', label = 'Terrain', description?: string): PortDef {
  return { id, type: 'field', label, description };
}

/** The standard terrain output port. */
export function terrainOut(id = 'out', label = 'Terrain'): PortDef {
  return { id, type: 'field', label };
}

/** The standard optional mask input, present on most filters. */
export function maskIn(id = 'mask'): PortDef {
  return {
    id,
    type: 'field',
    label: 'Mask',
    description:
      'Optional. Where the mask is 1 the effect applies fully; where it is 0 the input passes ' +
      'through untouched.',
    optional: true,
  };
}

/**
 * Blend a filter's result back over its input through an optional mask.
 *
 * Every filter in the catalog ends with this, which is why masking works
 * uniformly across the whole tool rather than being a per-node afterthought.
 */
export function applyMask(input: Field, result: Field, mask: PortValue): Field {
  if (!mask || typeof mask !== 'object' || !('data' in mask)) return result;
  const m = mask as Field;
  if (m.width !== input.width || m.height !== input.height) return result;
  return lerpFields(input, result, m);
}

/** Read a field input, substituting a zero field when it is absent. */
export function fieldOrZero(value: PortValue, ctx: EvalContext): Field {
  if (value && typeof value === 'object' && 'data' in value) return value as Field;
  return createField(ctx.width, ctx.height);
}

/** Read a field input, throwing a message that names the port when it is absent. */
export function requireField(value: PortValue, portLabel: string): Field {
  if (value && typeof value === 'object' && 'data' in value) return value as Field;
  throw new Error(`the "${portLabel}" input needs a terrain or mask connected`);
}

/** A copy of a field, for nodes that mutate in place. */
export function copyOf(field: Field): Field {
  return cloneField(field);
}
