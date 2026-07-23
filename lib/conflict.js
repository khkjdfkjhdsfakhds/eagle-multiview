'use strict';

function normalize(value) {
  if (Array.isArray(value)) {
    return [...value].map(String).sort();
  }
  return value ?? null;
}

function fieldsEqual(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function detectConflicts(current, base, patch) {
  const conflicts = [];
  for (const [field, requested] of Object.entries(patch || {})) {
    const previous = base?.[field];
    const latest = current?.[field];
    if (!fieldsEqual(latest, previous) && !fieldsEqual(latest, requested)) {
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
