interface Props {
  params: { id: string };
}

export default function UserPage({ params }: Props) {
  return (
    <main>
      <h1>User {params.id}</h1>
    </main>
  );
}