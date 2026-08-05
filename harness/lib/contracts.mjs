import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const names = ['run', 'plan', 'evidence', 'review'];
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validators = new Map(names.map((name) => {
  const url = new URL(`../contracts/${name}.schema.json`, import.meta.url);
  return [name, ajv.compile(JSON.parse(readFileSync(url, 'utf8')))];
}));

export function validateContract(name, value) {
  const validate = validators.get(name);
  if (!validate) throw new TypeError(`HONOLOLO_CONTRACT_UNKNOWN: ${name}`);
  if (!validate(value)) {
    const error = new TypeError(`HONOLOLO_${name.toUpperCase()}_INVALID`);
    error.details = validate.errors;
    throw error;
  }
  return value;
}

function reviewPlanInvalid(message, details = []) {
  const error = new TypeError('HONOLOLO_REVIEW_PLAN_INVALID');
  error.details = [{ instancePath: '', message }, ...details];
  throw error;
}

export function validateReviewForPlan(plan, review) {
  const approvedPlan = validateContract('plan', plan);
  const checkedReview = validateContract('review', review);
  if (approvedPlan.run_id !== checkedReview.run_id) {
    reviewPlanInvalid('review run_id does not match plan run_id');
  }

  const plannedCriteria = new Map();
  for (const step of approvedPlan.steps) {
    for (const criterion of step.done_when) {
      if (plannedCriteria.has(criterion.id)) {
        reviewPlanInvalid(`duplicate plan criterion ID: ${criterion.id}`);
      }
      plannedCriteria.set(criterion.id, criterion.type === 'rubric');
    }
  }

  const reviewedCriteria = new Set();
  for (const criterion of checkedReview.criteria) {
    if (reviewedCriteria.has(criterion.id)) {
      reviewPlanInvalid(`duplicate review criterion ID: ${criterion.id}`);
    }
    reviewedCriteria.add(criterion.id);

    const semantic = plannedCriteria.get(criterion.id);
    if (semantic === undefined) {
      reviewPlanInvalid(`unknown review criterion ID: ${criterion.id}`);
    }
    if ((checkedReview.source === 'fresh_evaluator') !== semantic) {
      reviewPlanInvalid(`review source cannot judge criterion ID: ${criterion.id}`);
    }
  }
  return checkedReview;
}
