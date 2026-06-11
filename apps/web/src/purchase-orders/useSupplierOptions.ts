import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { ApiError, SupplierOption } from '../lib/types';

// Loads active suppliers once for the purchase order form dropdown and for
// mapping supplier_id -> company_name on the list page.
export function useSupplierOptions(): {
  options: SupplierOption[];
  loading: boolean;
  error: ApiError | null;
} {
  const [options, setOptions] = useState<SupplierOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let active = true;
    apiClient
      .listSuppliers({ status: 'active', pageSize: 100 })
      .then((res) => {
        if (!active) return;
        setOptions(res.data.map((s) => ({ id: s.id, company_name: s.company_name })));
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof ApiError ? err : new ApiError(0, '加载供应商失败'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { options, loading, error };
}
