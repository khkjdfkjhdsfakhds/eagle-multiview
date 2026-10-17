'use strict';

// Eagle leaves out `star` when it is 0 and `annotation`/`url` when empty, so
// those defaults and a missing field are the same value (S-07).
const EMPTY_DEFAULTS = { star: 0, annotation: '', url: '' };

function normalize(value, field) {
  if (Array.isArray(value)) {
    return [...value].map(String).sort();
  }
  if (field in EMPTY_DEFAULTS && (value === undefined || value === null || value === EMPTY_DEFAULTS[field])) return null;
  return value ?? null;
}

function fieldsEqual(a, b, field = '') {
  return JSON.stringify(normalize(a, field)) === JSON.stringify(normalize(b, field));
}

function detectConflicts(current, base, patch) {
  const conflicts = [];
  for (const [field, requested] of Object.entries(patch || {})) {
    const previous = base?.[field];
    const latest = current?.[field];
    if (!fieldsEqual(latest, previous, field) && !fieldsEqual(latest, requested, field)) {
      conflicts.push({ field, previous, latest, requested });
    }
  }
  return conflicts;
}

function applySetDelta(currentValues, addValues = [], removeValues = []) {
  const values = new Set((currentValues || []).map(String));
  for (const value of addValues || []) values.add(String(value));
  for (const value of removeValues || []) values.delete(String(value));
  return [...values];
}

module.exports = { fieldsEqual, detectConflicts, applySetDelta };
