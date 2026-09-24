import Link from "next/link";

export default function NotFound() {
  return (
    <div className="hero">
      <h1>Not found</h1>
      <p>
        That page or study doesn't exist, or you don't have access. <Link href="/">Back to studies</Link>
      </p>
    </div>
  );
}
