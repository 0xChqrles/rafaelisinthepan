#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.argv[2] || 'public/game_data.json');
const errors = [];
const warnings = [];
const summary = [];

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addError(path, message) {
  errors.push(`${path}: ${message}`);
}

function addWarning(path, message) {
  warnings.push(`${path}: ${message}`);
}

function rankMapKeys(map) {
  return Object.keys(map).sort();
}

function sameKeys(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`Invalid JSON: ${file}`);
  console.error(error.message);
  process.exit(1);
}

if (!isObject(data)) {
  addError('$', `expected object, got ${typeOf(data)}`);
}

for (const [lang, langData] of Object.entries(isObject(data) ? data : {})) {
  const base = `$.${lang}`;
  if (!isObject(langData)) {
    addError(base, `expected object, got ${typeOf(langData)}`);
    continue;
  }

  const { phrases, ranks } = langData;
  if (!Array.isArray(phrases)) addError(`${base}.phrases`, `expected array, got ${typeOf(phrases)}`);
  if (!isObject(ranks)) addError(`${base}.ranks`, `expected object, got ${typeOf(ranks)}`);
  if (!Array.isArray(phrases) || !isObject(ranks)) continue;

  const rankEntries = Object.entries(ranks);
  if (rankEntries.length === 0) addError(`${base}.ranks`, 'must contain at least one secret');

  const sharedKeys = rankEntries.length ? rankMapKeys(rankEntries[0][1]) : [];
  const vocab = new Set();

  for (const [secret, map] of rankEntries) {
    const rankPath = `${base}.ranks.${secret}`;
    if (!isObject(map)) {
      addError(rankPath, `expected object, got ${typeOf(map)}`);
      continue;
    }

    const keys = rankMapKeys(map);
    keys.forEach((word) => vocab.add(word));
    if (!sameKeys(keys, sharedKeys)) {
      addError(rankPath, 'rank maps must share the same vocabulary keys');
    }
    if (map[secret] !== 0) {
      addError(rankPath, `secret "${secret}" must have rank 0`);
    }

    const seenRanks = new Map();
    for (const [word, rank] of Object.entries(map)) {
      if (!Number.isInteger(rank) || rank < 0) {
        addError(`${rankPath}.${word}`, `rank must be a non-negative integer, got ${rank}`);
      }
      if (seenRanks.has(rank)) {
        addWarning(`${rankPath}.${word}`, `rank ${rank} also used by "${seenRanks.get(rank)}"`);
      } else {
        seenRanks.set(rank, word);
      }
    }
  }

  for (let i = 0; i < phrases.length; i += 1) {
    const phrase = phrases[i];
    const phrasePath = `${base}.phrases[${i}]`;
    if (!isObject(phrase)) {
      addError(phrasePath, `expected object, got ${typeOf(phrase)}`);
      continue;
    }

    if (!Number.isInteger(phrase.id)) addError(`${phrasePath}.id`, 'expected integer');
    if (!Array.isArray(phrase.words) || !phrase.words.every((w) => typeof w === 'string')) {
      addError(`${phrasePath}.words`, 'expected array of strings');
    }
    if (!Array.isArray(phrase.holes)) {
      addError(`${phrasePath}.holes`, `expected array, got ${typeOf(phrase.holes)}`);
      continue;
    }

    const usedPositions = new Set();
    for (let h = 0; h < phrase.holes.length; h += 1) {
      const hole = phrase.holes[h];
      const holePath = `${phrasePath}.holes[${h}]`;
      if (!isObject(hole)) {
        addError(holePath, `expected object, got ${typeOf(hole)}`);
        continue;
      }

      const { pos, secret, start, start_rank: startRank } = hole;
      if (!Number.isInteger(pos)) {
        addError(`${holePath}.pos`, 'expected integer');
      } else {
        if (usedPositions.has(pos)) addError(`${holePath}.pos`, `duplicate hole position ${pos}`);
        usedPositions.add(pos);
        if (Array.isArray(phrase.words) && (pos < 0 || pos >= phrase.words.length)) {
          addError(`${holePath}.pos`, `position ${pos} is outside words array`);
        }
      }

      if (typeof secret !== 'string') addError(`${holePath}.secret`, 'expected string');
      if (typeof start !== 'string') addError(`${holePath}.start`, 'expected string');
      if (!Number.isInteger(startRank)) addError(`${holePath}.start_rank`, 'expected integer');

      const map = ranks?.[secret];
      if (!isObject(map)) {
        addError(`${holePath}.secret`, `missing ranks map for "${secret}"`);
        continue;
      }

      if (Array.isArray(phrase.words) && Number.isInteger(pos) && phrase.words[pos] !== secret) {
        addWarning(`${holePath}.pos`, `words[${pos}] is "${phrase.words[pos]}", not secret "${secret}"`);
      }
      if (!(start in map)) {
        addError(`${holePath}.start`, `start word "${start}" is absent from ranks.${secret}`);
      } else if (map[start] !== startRank) {
        addError(`${holePath}.start_rank`, `expected ${map[start]} from ranks.${secret}.${start}, got ${startRank}`);
      }
    }
  }

  summary.push(`${lang}: ${phrases.length} phrase(s), ${rankEntries.length} secret rank map(s), ${vocab.size} shared vocab word(s)`);
}

if (warnings.length) {
  console.warn('Warnings:');
  for (const warning of warnings) console.warn(`- ${warning}`);
}

if (errors.length) {
  console.error('Errors:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`OK: ${file}`);
for (const line of summary) console.log(`- ${line}`);
