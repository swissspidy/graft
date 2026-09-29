// Test stand-ins for WordPress globals the client bundle maps to window.wp.*.
export default function apiFetch(): Promise<never> {
	return Promise.reject(new Error('apiFetch is not available in tests'));
}
const stub = () => null;
export const Button = stub;
export const Notice = stub;
export const Card = stub;
export const CardHeader = stub;
export const CardBody = stub;
export const Spinner = stub;
