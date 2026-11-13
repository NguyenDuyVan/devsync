# DevSync

Đồng bộ thông tin làm việc của một dự án giữa nhiều máy qua VPS riêng. Dữ liệu được mã hoá đầu-cuối: VPS chỉ lưu bản mã, không đọc được nội dung, tên file hay tên dự án.

## Thành phần

| Thư mục | Vai trò |
|---|---|
| `server/` | API HTTPS (Node 24, SQLite tích hợp, không thư viện ngoài), chạy Docker trên HappyFinate cổng `8743` |
| `extension/` | Extension VS Code: quét file, mã hoá, đẩy/kéo, xử lý xung đột, giao diện |

## Mục thông tin

| Mục | Phạm vi | Mặc định | Ghi chú |
|---|---|---|---|
| Bộ nhớ Claude | dự án | Tự động | `MEMORY.md` gộp theo dòng, file khác xung đột thì hỏi |
| Cấu hình Claude của dự án | dự án | Tự động | `.claude/settings.local.json` |
| Phiên chat Claude | dự án | Thủ công | `*.jsonl`, mở lại bằng `claude --resume` |
| File env / secret | dự án | Thủ công | Xem trước diff theo key, ẩn giá trị |
| Code đang làm dở | dự án | Thủ công | Patch của thay đổi chưa commit, luôn loại trừ env; không bao giờ tự áp |
| Skills, commands, CLAUDE.md | chung | Tự động | `~/.claude` |
| settings.json của Claude | chung | Thủ công | Thường chứa đường dẫn riêng của từng máy |

Chế độ: **Tự động** đẩy sau khi file ổn định 45 giây, kéo ngay khi máy khác cập nhật (realtime), quét dự phòng mỗi 15 phút. **Thủ công** chỉ chạy khi bấm nút và luôn có bước xem trước. **Tắt** bỏ qua mục đó.

## Cơ chế chính

| Vấn đề | Cách xử lý |
|---|---|
| Đường dẫn dự án khác nhau giữa các máy | Nhận diện dự án theo `git remote origin`; thư mục bộ nhớ Claude được tính lại theo đường dẫn của từng máy |
| Hai máy cùng sửa | Gộp kiểu outer join: giữ thay đổi của cả hai máy. Gộp 3 chiều dựa trên bản chung gần nhất lấy từ lịch sử server; chỗ hai máy sửa khác nhau được giữ cả hai kèm ghi chú `DevSync · <tên máy> · <thời gian>` |
| Định dạng ghi chú | Văn bản: khối `<<<<<<<`/`=======`/`>>>>>>>` (VS Code hiện nút chọn nhanh). `.env`: giữ giá trị máy này, giá trị máy kia thành dòng `# DevSync · …`. JSON: gộp theo key, mảng hợp nhất, giá trị đơn khác nhau giữ bản máy này và ghi vào mục cần xem lại. `MEMORY.md`, `*.jsonl`: hợp nhất dòng. File nhị phân: giữ cả hai file |
| Mục cần xem lại | File gộp có ghi chú hiện trong cây dự án; tự biến mất khi xoá hết dấu `DevSync ·` |
| Xoá file | Lan sang máy khác; bản trên máy nhận được chuyển vào thùng rác của extension |
| Nhiều cửa sổ VS Code | Chỉ một cửa sổ chạy đồng bộ nền; các thao tác dùng chung file khoá |
| Lịch sử | Server giữ tối thiểu 20 phiên bản gần nhất hoặc 30 ngày, khôi phục được từng file |
| Bảo mật | HTTPS với chứng chỉ tự ký được ghim theo vân tay; mỗi thiết bị có token riêng, thu hồi được; khoá giới hạn số lần thử sai; AES-256-GCM, khoá chỉ nằm trên máy |

## Triển khai server

```bash
cd server && ./deploy.sh
ssh HappyFinate 'docker exec devsync node src/admin.ts invite'
```

Container giới hạn 256MB RAM và 0.5 CPU, chạy user không phải root, bỏ toàn bộ capability, dữ liệu ở `/opt/devsync/data`. Không đụng tới Traefik hay các dịch vụ khác trên VPS.

Lệnh quản trị: `admin.ts invite | devices | revoke <id> | fingerprint`.

## Cài extension

```bash
cd extension && pnpm install && npx tsc -p . && npx vsce package --no-dependencies --allow-missing-repository --skip-license
code --install-extension devsync-<version>.vsix
```

1. Máy đầu tiên: `DevSync: Kết nối máy chủ`, dán chuỗi `devsync://…` lấy từ lệnh `invite`. Extension tạo khoá đồng bộ: **lưu khoá vào trình quản lý mật khẩu**, mất khoá thì không đọc lại được dữ liệu.
2. Máy tiếp theo: trên máy đã kết nối, bấm biểu tượng thêm người ở khung Thiết bị (`Tạo mã ghép thiết bị mới`). Chuỗi được sao chép đã kèm khoá; dán vào máy mới.
3. Thêm dự án bằng nút `+` ở khung Dự án. Máy kia mở cùng repo sẽ được gợi ý liên kết.

## Phát hành và tự cập nhật

```bash
cd extension && node scripts/release.mjs patch --notes "mô tả ngắn"
```

Script tăng version, đóng gói, ký Ed25519 bằng `~/.devsync/release-key.pem` rồi đưa lên server. Các máy đang mở VS Code nhận sự kiện realtime, xác minh chữ ký với public key gắn trong extension rồi tự cài; cửa sổ hỏi tải lại để dùng bản mới. Bản không có chữ ký hợp lệ bị bỏ qua, nên VPS bị xâm nhập cũng không đẩy được code lạ. Tắt bằng `devsync.autoUpdate`.

Khoá ký chỉ nằm trên máy phát hành: sao lưu `~/.devsync/release-key.pem` vào trình quản lý mật khẩu.

## Bàn giao

Nút bàn giao trên dự án đẩy các mục đã chọn, đóng gói code dở và gửi kèm ghi chú. Máy kia nhận thông báo với hai lựa chọn: **Kéo tất cả** hoặc **Áp code dở**.
