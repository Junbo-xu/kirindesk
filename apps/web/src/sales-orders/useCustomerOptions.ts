import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { ApiError, CustomerOption } from '../lib/types';

// Loads active customers once for the order form dropdown and for mapping
// customer_id -> company_name on the list page.
export function useCustomerOptions(): {
  options: CustomerOption[];
  loading: boolean;
  error: ApiError | null;
} {
  const [options, setOptions] = useState<CustomerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let active = true;
    apiClient
      .listCustomers({ status: 'active', pageSize: 100 })
      .then((res) => {
        if (!active) return;
        setOptions(res.data.map((c) => ({ id: c.id, company_name: c.company_name })));
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof ApiError ? err : new ApiError(0, '加载客户失败'));
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
