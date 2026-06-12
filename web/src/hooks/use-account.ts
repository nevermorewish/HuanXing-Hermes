import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidateModelOptionsCache } from "@/lib/model-options-cache";
import type {
  AccountBalanceInfo,
  AccountLoginInput,
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
    onSuccess: () => {
      // The account provider was written into the runtime config; refresh the
      // config-derived caches so the new models show up in the chat switcher.
      invalidateModelOptionsCache();
      qc.invalidateQueries({ queryKey: ["account-status"] });
      qc.invalidateQueries({ queryKey: ["config"] });
      qc.invalidateQueries({ queryKey: ["model-info"] });
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
