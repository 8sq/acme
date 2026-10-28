import { runtime } from "@acme/server";
import { useLoaderData } from "react-router";

export const loader = () => {
  return { runtime: runtime.name };
};

export default function Home() {
  const data = useLoaderData<typeof loader>();

  return <h1>Hello from {data.runtime}</h1>;
}
