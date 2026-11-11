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
| Hai máy cùng sửa | Mỗi bản ghi có version; server từ chối ghi đè (409). Extension đánh dấu xung đột và mở diff để chọn |
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
cd extension && pnpm install --ignore-workspace && pnpm run package
code --install-extension devsync-0.1.0.vsix
```

1. Máy đầu tiên: `DevSync: Kết nối máy chủ`, dán chuỗi `devsync://…` lấy từ lệnh `invite`. Extension tạo khoá đồng bộ: **lưu khoá vào trình quản lý mật khẩu**, mất khoá thì không đọc lại được dữ liệu.
2. Máy tiếp theo: trên máy đã kết nối, bấm biểu tượng thêm người ở khung Thiết bị (`Tạo mã ghép thiết bị mới`). Chuỗi được sao chép đã kèm khoá; dán vào máy mới.
3. Thêm dự án bằng nút `+` ở khung Dự án. Máy kia mở cùng repo sẽ được gợi ý liên kết.

## Bàn giao

Nút bàn giao trên dự án đẩy các mục đã chọn, đóng gói code dở và gửi kèm ghi chú. Máy kia nhận thông báo với hai lựa chọn: **Kéo tất cả** hoặc **Áp code dở**.
