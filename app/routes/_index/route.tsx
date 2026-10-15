import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const params = url.searchParams;

  // Anything coming from the Shopify admin goes straight into the app.
  if (params.get("shop") || params.get("host") || params.get("embedded")) {
    throw redirect(`/app?${params.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>SKU Doctor</h1>
        <p className={styles.text}>
          Find and fix catalog problems before they cost you money, and build
          wholesale line sheets in minutes.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Your store&apos;s Shopify domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="your-store.myshopify.com"
              />
            </label>
            <button className={styles.button} type="submit">
              Open SKU Doctor
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Catalog audit</strong>
            <span>
              Flags prices below cost, missing weights, duplicate SKUs, thin
              margins and more across every variant.
            </span>
          </li>
          <li>
            <strong>Warehouse comparison</strong>
            <span>
              Checks weights, costs and barcodes against your WMS, starting
              with ShipHero.
            </span>
          </li>
          <li>
            <strong>Wholesale line sheets</strong>
            <span>
              Pick products, set wholesale pricing and get a print-ready PDF
              or spreadsheet.
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}
