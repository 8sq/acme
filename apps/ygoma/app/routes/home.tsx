import { getDb } from "@acme/app/db";
import { runtime } from "@acme/app/server";
import { useLoaderData } from "react-router";

declare module "@acme/app/db" {
  interface Databases {
    default: Record<string, never>;
  }
}

export const loader = async () => {
  const query = getDb().selectNoFrom((builder) => builder.lit(1).as("one"));
  const { one } = await query.executeTakeFirstOrThrow();
  return { runtime: runtime.name, one };
};

export default function Home() {
  const data = useLoaderData<typeof loader>();

  return (
    <>
      <h1>Hello from {data.runtime}</h1>
      <p>The database says {data.one}.</p>
    </>
  );
}
