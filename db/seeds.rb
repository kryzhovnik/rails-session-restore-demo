# Synthetic accounts for the in-browser restore demo.
# Both users and the private notes are seeded BEFORE the backup is taken,
# so they are present again after the restore. No session rows are seeded;
# every session is created through the normal login endpoint (Carol signs in
# before the backup, from the service worker).
# Short passwords keep the demo easy to type; they are not real credentials.
User.destroy_all

alice = User.create!(email_address: "alice@example.test", password: "1234")
alice.notes.create!(body: "Dentist on Tuesday at 10:00.")

bob = User.create!(email_address: "bob@example.test", password: "4321")
bob.notes.create!(body: "I love writing code by hand.")

carol = User.create!(email_address: "carol@example.test", password: "5678")
carol.notes.create!(body: "Water the office plants.")

puts "[seed] alice id=#{alice.id} email=#{alice.email_address}"
puts "[seed] bob   id=#{bob.id} email=#{bob.email_address}"
puts "[seed] carol id=#{carol.id} email=#{carol.email_address}"
