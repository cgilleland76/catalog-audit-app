import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { FAQ, supportEmail } from "../lib/site-content";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { email: supportEmail(), shop: session.shop };
};

export default function SupportPage() {
  const { email, shop } = useLoaderData<typeof loader>();
  const mailto = email
    ? `mailto:${email}?subject=${encodeURIComponent(`SKU Doctor support (${shop})`)}`
    : null;

  return (
    <s-page heading="Support">
      <s-section heading="Contact us">
        <s-stack direction="block" gap="base">
          {mailto ? (
            <>
              <s-paragraph>
                Questions, problems or ideas? Email{" "}
                <s-link href={mailto} target="_blank">
                  {email}
                </s-link>{" "}
                and we&apos;ll get back to you as soon as we can. Your store
                address is included automatically.
              </s-paragraph>
              <s-button variant="primary" href={mailto} target="_blank">
                Email support
              </s-button>
            </>
          ) : (
            <s-paragraph>Our support address is being set up.</s-paragraph>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Frequently asked questions">
        <s-stack direction="block" gap="base">
          {FAQ.map((f) => (
            <s-stack key={f.question} direction="block" gap="small-300">
              <s-heading>{f.question}</s-heading>
              <s-paragraph>{f.answer}</s-paragraph>
            </s-stack>
          ))}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="More">
        <s-unordered-list>
          <s-list-item>
            <s-link href="/app/updates">What&apos;s new</s-link>
          </s-list-item>
          <s-list-item>
            <s-link href="https://sku-doctor.netlify.app/privacy" target="_blank">
              Privacy policy
            </s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
