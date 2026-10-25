import { runtime } from "@acme/app";
import { useLoaderData } from "react-router";

export const loader = () => {
  return { runtime: runtime.name };
};

export default function Home() {
  const data = useLoaderData<typeof loader>();

  debugger;
  return <h1>Hello from {data.runtime}</h1>;
}
