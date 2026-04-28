import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import YAML from 'js-yaml';

let _profile = null;

export function loadProfile() {
  if (_profile) return _profile;

  const profilePath = process.env.PROFILE_PATH || resolve(new URL('.', import.meta.url).pathname, '../config/profile.yml');

  if (!existsSync(profilePath)) {
    console.warn(`[profile] not found at ${profilePath} — using defaults`);
    return getDefaults();
  }

  try {
    const content = readFileSync(profilePath, 'utf-8');
    _profile = YAML.load(content);
    console.log(`[profile] loaded from ${profilePath}`);
    return _profile;
  } catch (err) {
    console.error(`[profile] failed to load: ${err.message}`);
    return getDefaults();
  }
}

function getDefaults() {
  return {
    job_search_criteria: {
      allowed_locations: ['United States', 'Remote'],
      require_fully_remote: true,
      target_role_keywords: [
        'data engineer', 'data scientist', 'cloud engineer', 'ml engineer',
        'ai engineer', 'analytics engineer', 'machine learning', 'data science',
      ],
      exclude_role_keywords: ['manager', 'director', 'vp', 'head of', 'chief'],
      excluded_companies: ['meta', 'facebook', 'google', 'amazon', 'apple'],
      company_bonuses: [],
    },
    candidate_profile: 'Data professional with strong ML/data infrastructure background',
    scoring_priorities: [],
  };
}

export function getCriteria() {
  const profile = loadProfile();
  return profile.job_search_criteria || getDefaults().job_search_criteria;
}

export function getCandidateProfile() {
  const profile = loadProfile();
  return profile.candidate_profile || getDefaults().candidate_profile;
}

export function getCompanyBonuses() {
  const profile = loadProfile();
  const bonuses = profile.job_search_criteria?.company_bonuses || [];
  return new Map(bonuses.map(b => [b.company.toLowerCase(), b.bonus_points]));
}
