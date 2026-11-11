const text = (value) => typeof value === 'string' && value.trim() !== '';

export function evaluateScopeFit(decision) {
  const scope = decision?.scope_decision;
  const fit = decision?.fit_decision;
  if (!scope || !fit) return { coherent: false, reason: 'scope_decision and fit_decision are both required', nextAction: 'stop' };
  if (!text(fit.failure_class) || !text(decision.continuation)) {
    return { coherent: false, reason: 'failure_class and continuation are required', nextAction: 'stop' };
  }
  if (scope.owner !== 'none' && (!text(scope.authority) || scope.authority === 'none'
    || !text(fit.mandatory_consumer) || fit.mandatory_consumer === 'none'
    || !text(fit.intervention_point) || fit.intervention_point === 'none'
    || !text(fit.counterfactual_proof) || fit.counterfactual_proof === 'none')) {
    return { coherent: false, reason: 'active routes require authority, a mandatory consumer, an intervention point, and counterfactual proof', nextAction: 'stop' };
  }
  if (scope.owner === 'third_party') {
    if (scope.allowed_edit_root !== 'none' || scope.route !== 'proposal') {
      return { coherent: false, reason: 'third-party authority permits proposal only and no edit root', nextAction: 'propose' };
    }
  } else if (scope.owner === 'ours') {
    if (scope.route !== 'direct' || !text(scope.allowed_edit_root) || scope.allowed_edit_root === 'none') {
      return { coherent: false, reason: 'direct owned changes require an edit root, consumer, and intervention point', nextAction: 'stop' };
    }
  } else if (scope.owner === 'none') {
    if (scope.route !== 'archive' || scope.allowed_edit_root !== 'none' || scope.authority !== 'none') {
      return { coherent: false, reason: 'no applicable authority must archive without an edit root', nextAction: 'archive' };
    }
  } else return { coherent: false, reason: 'owner must be ours, third_party, or none', nextAction: 'stop' };
  return { coherent: true, reason: 'scope owner, route, consumer and intervention are coherent', nextAction: scope.route };
}
