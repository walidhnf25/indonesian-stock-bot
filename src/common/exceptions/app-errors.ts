/** Errors carrying a message that is safe to show to Telegram users (HTML). */
export class UserFacingError extends Error {
  constructor(
    public readonly userMessage: string,
    public readonly code: string = 'USER_ERROR',
  ) {
    super(userMessage);
    this.name = 'UserFacingError';
  }
}

export class InvalidTickerError extends UserFacingError {
  constructor(symbol: string) {
    super(
      `Ticker <b>${symbol}</b> tidak ditemukan di data provider. Pastikan kode saham IDX benar (4 huruf, mis. BBCA).`,
      'INVALID_TICKER',
    );
  }
}
