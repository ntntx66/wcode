declare module 'qrcode-terminal' {
  const qr: { generate(text: string, options: { small: boolean }): void };
  export default qr;
}
