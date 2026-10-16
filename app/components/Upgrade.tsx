import { PLANS, type PlanId } from "../lib/plans";

/** Full-page prompt shown instead of a feature the shop's plan doesn't include. */
export function UpgradeSection({
  feature,
  needs,
  upgradeUrl,
}: {
  feature: string;
  needs: Exclude<PlanId, "free">;
  upgradeUrl: string;
}) {
  const plan = PLANS[needs];
  return (
    <s-section>
      <s-stack direction="block" gap="base" alignItems="center" padding="large">
        <s-heading>
          {feature} is part of the {plan.name} plan
        </s-heading>
        <s-paragraph>
          {plan.name} ({plan.price}) includes: {plan.features.join(", ")}.
          Every paid plan starts with a 14-day free trial.
        </s-paragraph>
        <s-button variant="primary" href={upgradeUrl} target="_top">
          See plans
        </s-button>
      </s-stack>
    </s-section>
  );
}
