import { createVideoRequest } from "./actions";

const STYLES = [
  "Motivacional",
  "Educativo",
  "Humor",
  "Historias de terror",
  "Curiosidades",
  "Noticias / actualidad",
  "Storytelling personal",
];

const DURATIONS = [
  { value: 30, label: "30 segundos" },
  { value: 60, label: "60 segundos" },
  { value: 90, label: "90 segundos" },
];

export default async function NewVideoPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-bold text-gray-900">Generar nuevo video</h1>
      <p className="mt-1 text-sm text-gray-500">
        Describe el video que quieres. Por ahora guardamos tu solicitud; la
        generación automática se activará en la siguiente fase.
      </p>

      {error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <form
        action={createVideoRequest}
        className="mt-6 space-y-5 rounded-xl border border-gray-200 bg-white p-6 shadow-sm"
      >
        <div>
          <label htmlFor="topic" className="mb-1 block text-sm font-medium text-gray-700">
            Tema del video
          </label>
          <textarea
            id="topic"
            name="topic"
            required
            rows={3}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
            placeholder="Ej: 5 datos curiosos sobre el espacio que no sabías"
          />
        </div>

        <div>
          <label htmlFor="style" className="mb-1 block text-sm font-medium text-gray-700">
            Estilo / tono
          </label>
          <select
            id="style"
            name="style"
            required
            defaultValue=""
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
          >
            <option value="" disabled>
              Selecciona un estilo
            </option>
            {STYLES.map((style) => (
              <option key={style} value={style}>
                {style}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="duration_seconds"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Duración deseada
          </label>
          <select
            id="duration_seconds"
            name="duration_seconds"
            required
            defaultValue={60}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
          >
            {DURATIONS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          className="w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-700"
        >
          Guardar solicitud
        </button>
      </form>
    </div>
  );
}
