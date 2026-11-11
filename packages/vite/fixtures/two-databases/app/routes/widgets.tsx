import { getDb } from "@acme/app/db";
import { useLoaderData } from "react-router";

declare module "@acme/app/db" {
  interface Databases {
    default: { widget: { id: number } };
  }
}

export const loader = async () => {
  const widgets = await getDb().selectFrom("widget").selectAll().execute();
  return { count: widgets.length };
};

export default function Widgets() {
  const { count } = useLoaderData<typeof loader>();
  return <p>{count} widgets</p>;
}
