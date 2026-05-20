interface Props {
  params: { slug: string };
}

export default function ProductPage({ params }: Props) {
  return (
    <main>
      <h1>Product {params.slug}</h1>
    </main>
  );
}