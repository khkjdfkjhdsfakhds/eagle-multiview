'use strict';

const path = require('node:path');

// Eagle's tag list lags behind item edits made through its API: item/update
// with tags only reruns calculateTagsDebounce, which recolours and regroups
// the existing list but never adds a new name or recounts. The name appears
// only after Eagle next rebuilds its bindings (moving, deleting, restarting),
// so a tag first given in MultiView was missing from 标签管理 (V-01).
//
// Tags that item edits touched are remembered per library and recounted live
// with item/get's exact tag filter whenever the list is read. Names Eagle
// still lacks are added while some item carries them.
const LIMIT = 200;

class TagTally {
  constructor(client, { limit = LIMIT } = {}) {
    this.client = client;
    this.limit = limit;
    this.libraryPath = null;
    this.touched = new Set();
  }

  forLibrary(libraryPath) {
    const resolved = libraryPath ? path.resolve(libraryPath) : null;
    if (resolved !== this.libraryPath) {
      this.libraryPath = resolved;
      this.touched = new Set();
    }
  }

  // Returns true when a name was not seen before (the list may change).
  note(libraryPath, names = []) {
    this.forLibrary(libraryPath);
    let added = false;
    for (const name of names) {
      if (typeof name !== 'string' || !name) continue;
      // Most recently touched last, so the oldest falls off first.
      if (this.touched.has(name)) this.touched.delete(name);
      else added = true;
      this.touched.add(name);
      if (this.touched.size > this.limit) this.touched.delete(this.touched.values().next().value);
    }
    return added;
  }

  async merge(libraryPath, tags = []) {
    this.forLibrary(libraryPath);
    const names = [...this.touched];
    if (!names.length) return tags;
    const counts = new Map();
    let cursor = 0;
    const run = async () => {
      while (cursor < names.length) {
        const name = names[cursor++];
        // A failed count keeps Eagle's own number rather than hiding the tag.
        try { counts.set(name, await this.client.countItemsWithTag(name)); } catch {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, names.length) }, run));
    // The library may have switched while counting; the old counts would
    // then describe another library.
    if (this.libraryPath !== (libraryPath ? path.resolve(libraryPath) : null)) return tags;
    const listed = new Set();
    const merged = tags.map(tag => {
      listed.add(tag.name);
      return counts.has(tag.name) ? { ...tag, imageCount: counts.get(tag.name) } : tag;
    });
    for (const name of names) {
      if (!listed.has(name) && counts.get(name) > 0) merged.push({ name, imageCount: counts.get(name), groups: [] });
    }
    return merged;
  }
}

// Names whose membership changed between two versions of an item.
function changedTagNames(previous, next) {
  const before = new Set(Array.isArray(previous?.tags) ? previous.tags : []);
  const after = new Set(Array.isArray(next?.tags) ? next.tags : []);
  const changed = [];
  for (const name of after) if (!before.has(name)) changed.push(name);
  for (const name of before) if (!after.has(name)) changed.push(name);
  // An item moving into or out of the trash changes every count it holds.
  if (Boolean(previous?.isDeleted) !== Boolean(next?.isDeleted)) {
    for (const name of after) if (before.has(name)) changed.push(name);
  }
  return changed;
}

module.exports = { TagTally, changedTagNames };
