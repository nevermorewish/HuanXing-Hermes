import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rememberLastUsedModel } from "@/lib/last-used-model";
import { invalidateModelOptionsCache } from "@/lib/model-options-cache";
import { BRAND } from "@/lib/brand.generated";
import type {
  AccountBalanceInfo,
  AccountLoginInput,
  AccountSavedCredentialsInfo,
  AccountSaveModelsInput,
  AccountSetupResult,
  AccountStatusResult,
  AccountTestModelResult,
  AccountTokenInfo,
  AccountUser,
} from "@/lib/runtime";

// Account login hooks. All calls go through window.hermesDesktop.account*,
// which is backed by commands/account.rs in the Tauri process. The full sk-
// key never crosses this boundary — only a masked preview + hasKey.
//
// On non-desktop runtimes (web preview) the bridge is absent; the hooks throw a
// clear error so the UI can hide the login entry rather than crash.

function bridge() {
  const b = window.hermesDesktop;
  if (!b?.accountStatus) {
    throw new Error("账户登录仅在桌面版可用");
  }
  return b;
}

export function isAccountLoginAvailable(): boolean {
  return Boolean(window.hermesDesktop?.accountStatus);
}

export function useAccountStatus() {
  return useQuery<AccountStatusResult>({
    queryKey: ["account-status"],
    queryFn: () => bridge().accountStatus!(),
    enabled: isAccountLoginAvailable(),
    staleTime: 30_000,
  });
}

export function useAccountLogin() {
  const qc = useQueryClient();
  return useMutation<AccountUser, Error, AccountLoginInput>({
    mutationFn: (input) => bridge().accountLogin!(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["account-status"] });
    },
  });
}

export function useAccountFetchSetup() {
  return useMutation<AccountSetupResult, Error, void>({
    mutationFn: () => bridge().accountFetchSetup!(),
  });
}

export function useAccountTokens() {
  return useQuery<AccountTokenInfo[]>({
    queryKey: ["account-tokens"],
    queryFn: () => bridge().accountListTokens!(),
    enabled: false, // fetched on demand when the model-select step opens
    retry: false,
  });
}

export function useAccountBalance() {
  return useQuery<AccountBalanceInfo>({
    queryKey: ["account-balance"],
    queryFn: () => bridge().accountBalance!(),
    enabled: false, // fetched on demand when the account panel expands
    staleTime: 15_000,
  });
}

export function useAccountSaveModels() {
  const qc = useQueryClient();
  return useMutation<AccountStatusResult, Error, AccountSaveModelsInput>({
    mutationFn: (input) => bridge().accountSaveModels!(input),
    onSuccess: (_result, input) => {
      // The account provider was written into the runtime config; refresh the
      // config-derived caches so the new models show up in the chat switcher.
      const primaryModel = input.primaryModelId || input.models[0];
      if (primaryModel) {
        const provider = `custom:${BRAND.providerKey}`;
        rememberLastUsedModel({
          model: primaryModel,
          provider,
          providerName: BRAND.appName,
        });
        qc.setQueriesData<Record<string, unknown>>({ queryKey: ["model-info"] }, (old) => ({
          ...(old ?? {}),
          model: primaryModel,
          provider,
        }));
      }
      invalidateModelOptionsCache();
      qc.invalidateQueries({ queryKey: ["account-status"] });
      qc.invalidateQueries({ queryKey: ["config"] });
      qc.invalidateQueries({ queryKey: ["model-info"] });
      // The chat model picker reads ["model-options"] (gateway model.options
      // RPC), which has its own 5-min staleTime — without this the newly saved
      // account models don't appear until the cache expires.
      qc.invalidateQueries({ queryKey: ["model-options"] });
      void qc.refetchQueries({ queryKey: ["model-info"], type: "active" });
      void qc.refetchQueries({ queryKey: ["model-options"], type: "active" });
    },
  });
}

export function useAccountTestModel() {
  return useMutation<AccountTestModelResult, Error, string>({
    mutationFn: (modelId) => bridge().accountTestModel!(modelId),
  });
}

export function useAccountLogout() {
  const qc = useQueryClient();
  return useMutation<AccountStatusResult, Error, void>({
    mutationFn: () => bridge().accountLogout!(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["account-status"] });
    },
  });
}

export function useSavedCredentials() {
  return useQuery<AccountSavedCredentialsInfo>({
    queryKey: ["account-saved-credentials"],
    queryFn: () => bridge().accountHasSavedCredentials!(),
    enabled: isAccountLoginAvailable(),
    staleTime: 30_000,
  });
}

export function useSaveCredentials() {
  const qc = useQueryClient();
  return useMutation<void, Error, AccountLoginInput>({
    mutationFn: (input) => bridge().accountSaveCredentials!(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["account-saved-credentials"] });
    },
  });
}

export function useLoginSaved() {
  const qc = useQueryClient();
  return useMutation<AccountUser, Error, void>({
    mutationFn: () => bridge().accountLoginSaved!(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["account-status"] });
    },
  });
}

export function useClearCredentials() {
  const qc = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: () => bridge().accountClearCredentials!(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["account-saved-credentials"] });
    },
  });
}
