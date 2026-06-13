import { useQuery } from "@tanstack/react-query";
import type { ModelOptionsResult } from "@hermes/protocol";
import { useGateway } from "@/hooks/use-gateway";

// React Query handle for the server-global model.options. Shared cache means
// composer instances on /, /tasks/*, and compatible /new redirects don't each pay for their own
// initial fetch + spinner; once the first instance warms it, every other
// mount renders the picker fully populated.
//
// The underlying RPC also has a 5-min module cache (see getCachedModelOptions),
// so even a cold mount completes fast — but query-level state means the data
// is in component memory the instant the picker opens, no Promise → setState
// round trip needed.
export function useModelOptions() {
  const { getModelOptions } = useGateway();
  return useQuery<ModelOptionsResult>({
    queryKey: ["model-options"],
    queryFn: () => getModelOptions(),
    // No caching: always refetch so newly configured account models show up
    // immediately and stale provider lists (e.g. relay-advertised models) don't
    // linger in the picker.
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}
